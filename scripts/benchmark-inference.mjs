// Usage: node scripts/benchmark-inference.mjs ../album-atlas-v1.1 [output.json]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { platform, arch } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const baselineCommit = '5583e51885ac326eb46160eae898d0bb8a140cd0';
const [baselineDir, output] = process.argv.slice(2);
if (!baselineDir) throw new Error('Supply a clean v1.1.0 checkout. See docs/inference-responsiveness.md.');
const base = resolve(baselineDir);
const git = (...args) => execFileSync('git', ['-C', base, ...args], {encoding:'utf8'}).trim();
assert.equal(git('rev-parse','HEAD'), baselineCommit, 'The baseline must be the exact v1.1.0 release');
assert.equal(git('status','--porcelain','--untracked-files=no'), '', 'The baseline checkout must be clean');
const baseline = await import(pathToFileURL(join(base, 'scripts', 'serve.mjs')).href);
const servers = { main: await baseline.startServer({port:0}), worker: await startServer({port:0}) };
const report = { baselineCommit, platform: platform(), arch: arch(), dataset: '12 bundled demo JPEGs, workflow.ingest', trials: [], parity: [] };

// This function runs in the browser, on the production ingest entry point.
async function collect() {
  const {ingest} = await import('/src/workflow.js');
  const embedding = await import('/src/embedding.js');
  const {classify, cluster} = await import('/src/ml.js');
  const files = [];
  for (const album of ['shore','forest','city']) {
    for (let n=1; n<=4; n++) {
      const name = album + '-0' + n + '.jpg';
      const blob = await (await fetch('/assets/demo/'+name)).blob();
      files.push(new File([blob], name, {type:'image/jpeg'}));
    }
  }
  const records = [];
  for (const phase of ['cold','warm']) {
    const gaps = [], intervals = [];
    const start = performance.now();
    let tick = start, lastFile = start;
    const timer = setInterval(() => { const now=performance.now(); gaps.push(now-tick); tick=now; }, 20);
    const {photos, errors} = await ingest(files, () => {
      const now=performance.now(); intervals.push(Math.round(now-lastFile)); lastFile=now;
    });
    const end = performance.now();
    // Capture a delayed final callback even if inference blocked until ingest returned.
    await new Promise(ok => setTimeout(ok,60));
    clearInterval(timer);
    gaps.sort((a,b) => a-b);
    const quantile = q => Math.round(gaps[Math.floor(q*(gaps.length-1))]);
    const references = ['shore','forest','city'].map(id => ({
      id, vectors: photos.filter(p => p.name.startsWith(id) && /-0[12]/.test(p.name)).map(p => p.vector),
    }));
    const decisions = photos.filter(p => /-0[34]/.test(p.name)).map(p => {
      const result=classify(p.vector,references);
      return [p.name,result.albumId,result.suggestionId];
    });
    records.push({
      phase, elapsedMs: Math.round(end-start), maxGapMs:quantile(1), p95GapMs:quantile(.95),
      gapsOver100:gaps.filter(g=>g>100).length, gapsOver250:gaps.filter(g=>g>250).length,
      ticks:gaps.length, firstFileMs:intervals[0], files:photos.length, kinds:[...new Set(photos.map(p=>p.kind))], errors,
      runtime:embedding.inferenceDiagnostics?.() ?? { location:'main', backend:globalThis.tf?.getBackend() },
      decisions, cluster:cluster(photos.map(p=>p.vector),3), vectors:photos.map(p=>p.vector),
    });
    photos.forEach(p => URL.revokeObjectURL(p.url));
  }
  return records;
}

function denyWebGL() {
  for (const K of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas].filter(Boolean)) {
    const get = K.prototype.getContext;
    K.prototype.getContext = function(type,...args) {
      return String(type).includes('webgl') ? null : get.call(this,type,...args);
    };
  }
}

async function trial(route, cpu) {
  const browser = await chromium.launch({ channel:process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    report.browser = browser.version();
    const context = await browser.newContext({serviceWorkers:'block'});
    if (cpu) {
      await context.addInitScript(denyWebGL);
      // Window initialization scripts do not apply to a dedicated worker.
      await context.route('**/src/embed-worker.js', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body:'('+denyWebGL.toString()+')();\n'+await response.text()});
      });
    }
    const origin = 'http://127.0.0.1:' + servers[route].address().port;
    const unexpected = [];
    context.on('request', r => {
      const url = new URL(r.url());
      if (/^https?:$/.test(url.protocol) && (url.origin !== origin || r.method() !== 'GET')) unexpected.push(r.url());
    });
    const page = await context.newPage();
    await page.goto(origin);
    const rows = await page.evaluate(collect);
    assert.deepEqual(unexpected, []);
    for (const r of rows) {
      assert.equal(r.files, 12); assert.deepEqual(r.kinds, ['mobilenet']); assert.deepEqual(r.errors, []);
      assert.equal(r.runtime.backend, cpu?'cpu':'webgl');
      assert.equal(r.runtime.location, route);
    }
    return rows;
  } finally {
    await browser.close();
  }
}

function parity(a,b) {
  let maxAbsoluteDifference=0, maxCosineDeviation=0;
  for (let i=0; i<a.vectors.length; i++) {
    const v=a.vectors[i], w=b.vectors[i];
    assert.equal(v.length,w.length);
    let dot=0, aa=0, bb=0;
    for (let j=0; j<v.length; j++) {
      maxAbsoluteDifference=Math.max(maxAbsoluteDifference,Math.abs(v[j]-w[j]));
      dot+=v[j]*w[j]; aa+=v[j]*v[j]; bb+=w[j]*w[j];
    }
    maxCosineDeviation=Math.max(maxCosineDeviation,Math.abs(1-dot/Math.sqrt(aa*bb)));
  }
  assert.deepEqual(a.decisions,b.decisions); assert.deepEqual(a.cluster,b.cluster);
  assert.ok(Number.isFinite(maxAbsoluteDifference) && maxAbsoluteDifference < 1e-4,
    'Learned vector coordinates diverged by ' + maxAbsoluteDifference);
  return {maxAbsoluteDifference,maxCosineDeviation,assignmentParity:true,clusterParity:true};
}

try {
  for (let rep=0; rep<3; rep++) {
    for (const cpu of [false,true]) {
      const pair={};
      for (const route of rep%2 ? ['worker','main'] : ['main','worker']) {
        pair[route]=await trial(route,cpu);
        for (const {vectors, ...r} of pair[route]) {
          report.trials.push({rep,simulatedNoWebGL:cpu,...r});
          console.log(rep,r.runtime.backend,route,r.phase,'elapsed',r.elapsedMs,'max gap',r.maxGapMs,'p95',r.p95GapMs);
        }
      }
      for (const [i,row] of pair.main.entries()) {
        report.parity.push({rep,simulatedNoWebGL:cpu,phase:row.phase,...parity(row,pair.worker[i])});
      }
    }
  }
  if (output) await writeFile(output, JSON.stringify(report,null,2)+'\n');
} finally {
  await Promise.all(Object.values(servers).map(server => new Promise(ok => server.close(ok))));
}
