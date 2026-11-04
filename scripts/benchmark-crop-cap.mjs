// Usage: node scripts/benchmark-crop-cap.mjs [output.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const archive = 'docs/crop-practice.zip';
const members = ['01-coast-full.jpg', '02-coast-detail.jpg'];
const archiveSha256 = createHash('sha256').update(await readFile(new URL('../' + archive, import.meta.url))).digest('hex');
const server = await startServer({ port: 0 });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  const cdp = await browser.newBrowserCDPSession();
  await page.route('**/cap-benchmark.html', route => route.fulfill({ contentType: 'text/html', body: '<title>Crop cap benchmark</title>' }));
  await page.goto('http://127.0.0.1:' + server.address().port + '/cap-benchmark.html');
  await page.evaluate(async ({ archive, members }) => {
    const { unzipSync } = await import('/vendor/fflate.mjs');
    const { fingerprint } = await import('/src/duplicates.js');
    const files = unzipSync(new Uint8Array(await (await fetch('/' + archive)).arrayBuffer()));
    const examples = [];
    for (const name of members) {
      if (!files[name]) throw new Error('Missing practice member: ' + name);
      const blob = new Blob([files[name]], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob), img = new Image();
      try {
        img.src = url;
        await img.decode();
        examples.push({ blob, fingerprint: await fingerprint(blob, img) });
      } finally { URL.revokeObjectURL(url); }
    }
    // Exact repetitions within each half are filtered by the ordinary duplicate
    // matcher. Every original/detail cross-pair still has to be inspected.
    window.benchPhotos = Array.from({ length: 300 }, (_, i) => ({
      ...examples[i < 150 ? 0 : 1], id: (i < 150 ? 'full-' : 'detail-') + (i % 150),
    }));
    window.benchScan = (await import('/src/crop-scan.js')).scanCrops;
  }, { archive, members });

  async function rendererCpu() {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    return new Map(processInfo.filter(p => p.type === 'renderer').map(p => [p.id, p.cpuTime]));
  }
  async function timed(work, argument) {
    const before = await rendererCpu();
    const result = await page.evaluate(work, argument);
    const after = await rendererCpu();
    // Exiting a renderer would lose its final CPU accounting. Reject that sample.
    for (const pid of before.keys()) assert.ok(after.has(pid), 'A benchmark renderer exited during measurement');
    result.rendererCpuMs = Math.round([...after].reduce((sum, [pid,time]) => sum + time - (before.get(pid) || 0), 0) * 1000);
    return result;
  }

  const production = [];
  for (let run = 0; run < 3; run++) {
    const sample = await timed(async () => {
      const gaps = [], start = performance.now();
      let previous = start;
      const timer = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 20);
      let result;
      try { result = await benchScan(benchPhotos); } finally { clearInterval(timer); }
      const end = performance.now();
      if (end - previous > 20) gaps.push(end - previous);
      gaps.sort((a,b) => a - b);
      const { pairs, ...counts } = result;
      if (pairs.some((p,i) => p.originalId !== 'full-0' || p.cropId !== 'detail-' + i)) throw new Error('Unexpected pair identity or order');
      return { wallMs:Math.round(end-start), heartbeatTicks:gaps.length,
        heartbeatP95Ms:Math.round(gaps[Math.floor(.95*(gaps.length-1))]), heartbeatMaxMs:Math.round(gaps.at(-1)),
        retained:pairs.length, ...counts };
    });
    assert.deepEqual([sample.retained,sample.atLeast,sample.examinedPairs,sample.totalPairs,sample.truncated], [60,61,210,44850,true]);
    assert.ok(sample.heartbeatTicks > 0);
    production.push(sample);
  }

  await page.evaluate(async () => {
    const { encodeCropPhoto, scanCropPairs, compareCropPair } = await import('/src/crop-evidence.js');
    const full = await encodeCropPhoto(benchPhotos[0]), detail = await encodeCropPhoto(benchPhotos[150]);
    window.benchRecords = benchPhotos.map((p,i) => ({ ...(i < 150 ? full : detail), id:p.id }));
    window.benchPair = compareCropPair;
    window.benchCapped = scanCropPairs;
  });
  const pairOnly = { capped:[], exhaustive:[] };
  for (let run = 0; run < 3; run++) {
    for (const mode of run % 2 ? ['exhaustive','capped'] : ['capped','exhaustive']) {
      const measurement = await timed(mode => {
        const start = performance.now();
        let examined = 0, hits = 0;
        if (mode === 'capped') {
          const r = benchCapped(benchRecords);
          examined = r.examinedPairs;
          hits = r.atLeast;
        } else {
          for (let i=0; i<benchRecords.length; i++) for (let j=i+1; j<benchRecords.length; j++) {
            examined++;
            if (benchPair(benchRecords[i],benchRecords[j])) hits++;
          }
        }
        return { wallMs:Math.round(performance.now()-start), examined,hits };
      }, mode);
      assert.deepEqual([measurement.examined,measurement.hits], mode === 'capped' ? [210,61] : [44850,22500]);
      pairOnly[mode].push(measurement);
    }
  }

  const cancellation = await page.evaluate(async () => {
    const controller = new AbortController();
    let canceledAt, lateProgress = 0, errorName = null;
    try {
      await benchScan(benchPhotos, { signal:controller.signal, onProgress: progress => {
        if (controller.signal.aborted) { lateProgress++; return; }
        if (progress.completed > 0) { canceledAt = progress; controller.abort(); }
      }});
    } catch (error) { errorName = error.name; }
    await new Promise(resolve => setTimeout(resolve, 250));
    return { canceledAt,errorName,observedAfterMs:250,lateProgress };
  });
  assert.equal(cancellation.errorName, 'AbortError');
  assert.ok(cancellation.canceledAt);
  assert.equal(cancellation.lateProgress, 0);
  const report = {
    version:1, browser:browser.version(), platform:process.platform + '-' + process.arch, archive,archiveSha256,members,
    fixture:'Repeated-content stress: 150 handles for one full image followed by 150 handles for its crop, unique IDs and two shared immutable JPEG blobs.',
    productionScope:'Fresh real scan worker per run. Includes worker launch, 300 image decodes, indexing and capped comparison; ordinary whole-frame fingerprints already exist. Page heartbeat interval is 20 ms.',
    comparisonScope:'Both pure loops run in the same renderer on the same 300 IDs; each distinct JPEG was crop-encoded once before timing. Exhaustive loop counts hits without allocating a result list.',
    cpuScope:'Sum of renderer-process CPU-time deltas in isolated Chromium, including the dedicated worker when present; excludes browser/GPU processes.',
    production,pairOnly,cancellation,
  };
  const json = JSON.stringify(report,null,2)+'\n';
  if (process.argv[2]) await writeFile(process.argv[2],json);
  else process.stdout.write(json);
  console.error('PASS 60 retained, 61 confirmed in 210 pairs; exhaustive 22,500 hits in 44,850 pairs; cancellation clean');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
