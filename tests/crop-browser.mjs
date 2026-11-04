import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../scripts/serve.mjs';
import { unzipSync } from '../vendor/fflate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), 'album-atlas-crop-test-'));
const server = await startServer({ port: 0 });
const origin = 'http://127.0.0.1:' + server.address().port;
const timeout = 120_000;
const master = 'oriented-master.jpg',
  copy = 'identical-spare.jpg';
const crop = 'tight-view.jpg',
  unrelated = 'other-scene.jpg';
const box = { x: 4 / 64, y: 11 / 64, w: 50 / 64, h: 50 / 64 };
const file = (name) => path.join(scratch, name);
const cropWorker = (url) => new URL(url).pathname === '/src/crop-worker.js';
const state = (page, value) =>
  page.locator('#crop-review[data-crop-state="' + value + '"]').waitFor({ timeout });

// The JPEG is stored sideways. A minimal standards-compliant EXIF APP1 marks it
// for 90° clockwise display. The ground truth rectangle below is on the upright image.
function orientationSix(jpeg) {
  assert.equal(jpeg.readUInt16BE(0), 0xffd8);
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
}

async function makeFixtures(page) {
  // Runtime derivatives of a licensed image already shipped by Album Atlas.
  // No Pillow, internet access, fixture downloads, or new binary assets are needed.
  const generated = await page.evaluate(async (region) => {
    const photo = new Image();
    photo.src = './assets/demo/city-03.jpg';
    await photo.decode();
    const make = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
    const wide = make(896, 576);
    wide.getContext('2d').drawImage(photo, 0, 0, wide.width, wide.height);
    const raw = make(wide.height, wide.width);
    const ctx = raw.getContext('2d');
    ctx.setTransform(0, -1, 1, 0, 0, wide.width);
    ctx.drawImage(wide, 0, 0);
    const detail = make(wide.width * region.w, wide.height * region.h);
    detail
      .getContext('2d')
      .drawImage(
        wide,
        wide.width * region.x,
        wide.height * region.y,
        detail.width,
        detail.height,
        0,
        0,
        detail.width,
        detail.height,
      );
    const jpeg = (canvas) => canvas.toDataURL('image/jpeg', 0.94).split(',')[1];
    return { raw: jpeg(raw), detail: jpeg(detail) };
  }, box);
  const original = orientationSix(Buffer.from(generated.raw, 'base64'));
  await Promise.all([
    writeFile(file(master), original),
    writeFile(file(copy), original),
    writeFile(file(crop), Buffer.from(generated.detail, 'base64')),
    copyFile(path.join(root, 'assets/demo/forest-01.jpg'), file(unrelated)),
  ]);
  const dims = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/jpeg;base64,' + base64;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, original.toString('base64'));
  assert.deepEqual(dims, [896, 576], 'EXIF rotates the 576×896 stored pixels into a landscape original');
}

async function open(context) {
  const page = await context.newPage();
  await page.goto(origin);
  await page.locator('#workspace[aria-busy="false"]').waitFor();
  await page.locator('#language').click();
  await page.locator('#discover').click();
  return page;
}

async function importPhotos(page, names, expectedCount = names.length) {
  const opened = page.waitForEvent('filechooser');
  await page.locator('#choose').click();
  await (await opened).setFiles(names.map(file));
  await page.waitForFunction(
    (n) =>
      document.querySelector('#workspace').getAttribute('aria-busy') === 'false' &&
      document.querySelector('.well .meta')?.textContent === n + ' photos',
    expectedCount,
    { timeout },
  );
}

async function choosePlan(page) {
  await page.getByRole('button', { name: 'Generate plans', exact: true }).click();
  await page.locator('.plan').first().click();
  await page.locator('#review .photo-card').first().waitFor();
}

async function verifyZip(page, kept, skipped = []) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  const result = await download;
  assert.equal(await result.failure(), null);
  const files = unzipSync(new Uint8Array(await readFile(await result.path())));
  const manifest = JSON.parse(new TextDecoder().decode(files['album-atlas.json']));
  assert.deepEqual(manifest.photos.map((p) => p.original).sort(), [...kept].sort());
  assert.deepEqual((manifest.skippedCopies || []).map((p) => p.original).sort(), [...skipped].sort());
  assert.equal(Object.keys(files).length, kept.length + 1);
  for (const record of manifest.photos) {
    assert.deepEqual(Buffer.from(files[record.path]), await readFile(file(record.original)));
  }
}

async function fittedGeometry(dialog) {
  return dialog.evaluate((element) => {
    const figure = element.querySelector('[data-crop-role="original"]');
    const image = figure.querySelector('img');
    const outer = image.getBoundingClientRect(),
      inner = figure.querySelector('[data-crop-box]').getBoundingClientRect();
    return {
      imageWidth: outer.width,
      imageHeight: outer.height,
      original: [image.naturalWidth, image.naturalHeight],
      crop: [...element.querySelectorAll('[data-crop-role="crop"] img')].map((n) => [
        n.naturalWidth,
        n.naturalHeight,
      ])[0],
      box: {
        x: (inner.x - outer.x) / outer.width,
        y: (inner.y - outer.y) / outer.height,
        w: inner.width / outer.width,
        h: inner.height / outer.height,
      },
    };
  });
}
function verifyGeometry(data) {
  assert.deepEqual(
    data.original,
    [896, 576],
    'the containing full-resolution image labels the original pane',
  );
  assert.ok(
    Math.abs(data.imageWidth / data.imageHeight - 896 / 576) < 0.015,
    'The displayed original preserves the upright aspect ratio',
  );
  assert.deepEqual(data.crop, [700, 450], 'the smaller view labels the comparison pane');
  for (const key of ['x', 'y', 'w', 'h']) {
    assert.ok(
      Math.abs(data.box[key] - box[key]) < 0.05,
      'Visible crop overlay ' +
        key +
        ' must follow the displayed original: ' +
        JSON.stringify({ actual: data.box, expected: box }),
    );
  }
}

async function compareCrop(page) {
  const row = page.locator('[data-crop-pair]').filter({ hasText: master }).filter({ hasText: crop }).first();
  await row.click();
  const dialog = page.locator('#crop-dialog');
  await dialog.waitFor();
  await dialog.locator('img').evaluateAll((images) => Promise.all(images.map((img) => img.decode())));
  verifyGeometry(await fittedGeometry(dialog));
  await dialog.locator('[data-crop-zoom="1"]').click();
  const one = await fittedGeometry(dialog);
  verifyGeometry(one);
  await dialog.locator('[data-crop-zoom="2"]').click();
  const two = await fittedGeometry(dialog);
  verifyGeometry(two);
  assert.ok(two.imageWidth > one.imageWidth * 1.8, '2× enlarges actual image detail compared with 1×');
  await dialog.locator('[data-crop-zoom="fit"]').click();
  await page.setViewportSize({ width: 375, height: 820 });
  verifyGeometry(await fittedGeometry(dialog));
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'No page overflow on mobile',
  );
  assert.ok(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    'Comparison dialog fits a mobile screen',
  );
  await dialog.locator('#crop-close').click();
  const pairIndex = await row.getAttribute('data-crop-pair');
  await page.waitForFunction((index) => document.activeElement?.dataset.cropPair === index, pairIndex);
  await row.click();
  await dialog.locator('#crop-reviewed').click();
  if (await dialog.isVisible()) await dialog.locator('#crop-close').click();
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function controlDelivery(context) {
  // Execute the real worker and matcher even in the race tests. Delay only delivery
  // of its final message, then release that genuine result after cancel/import/reset.
  await context.addInitScript(() => {
    const NativeWorker = window.Worker;
    const gate = { started: 0, hold: false, queued: [] };
    window.__cropQa = gate;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (new URL(url, location.href).pathname !== '/src/crop-worker.js') return;
        gate.started++;
        this.addEventListener('message', (event) => {
          if (gate.hold && event.data?.type === 'result') {
            event.stopImmediatePropagation();
            gate.queued.push({ worker: this, payload: event.data });
          }
        });
      }
    };
  });
}

async function withQueuedResult(page, action) {
  await page.evaluate(() => {
    window.__cropQa.hold = true;
  });
  await page.locator('#crop-start').click();
  await state(page, 'scanning');
  await page.waitForFunction(() => window.__cropQa.queued.length === 1, null, { timeout });
  await action();
  await page.evaluate(async () => {
    const gate = window.__cropQa;
    gate.hold = false;
    for (const { worker, payload } of gate.queued.splice(0))
      worker.dispatchEvent(new MessageEvent('message', { data: payload }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function clearDesk(page) {
  await page.locator('#reset').click();
  await page.locator('#clear-confirm').click();
  await page.locator('#crop-review').waitFor({ state: 'hidden' });
}

async function verifyLifecycle(page) {
  await withQueuedResult(page, async () => {
    await page.locator('#crop-cancel').click();
    await state(page, 'canceled');
  });
  await state(page, 'canceled');
  assert.equal(await page.locator('[data-crop-pair]').count(), 0);
  await page.locator('#crop-start').click();
  await state(page, 'done');
  assert.ok((await page.locator('[data-crop-pair]').count()) > 0, 'Canceled work can be restarted');

  const extra = 'later-import.jpg';
  await copyFile(path.join(root, 'assets/demo/shore-03.jpg'), file(extra));
  await withQueuedResult(page, () => importPhotos(page, [extra], 5));
  await state(page, 'idle');
  assert.equal(
    await page.locator('[data-crop-pair]').count(),
    0,
    'A late result cannot replace a new import',
  );
  await withQueuedResult(page, () => clearDesk(page));
  assert.equal(await page.locator('[data-crop-pair]').count(), 0);
  assert.ok(await page.locator('#crop-review').isHidden(), 'A late result cannot resurrect a cleared desk');
}

async function verifyDense(page) {
  const names = [];
  for (const [prefix, fixture] of [
    ['wide', master],
    ['detail', crop],
  ]) {
    for (let i = 0; i < 9; i++) {
      const name = prefix + '-' + String(i).padStart(2, '0') + '.jpg';
      await copyFile(file(fixture), file(name));
      names.push(name);
    }
  }
  await importPhotos(page, names);
  await page.locator('#crop-start').click();
  await state(page, 'done');
  assert.match(await page.locator('#crop-truncated').innerText(), /at least 61.*first 60/i);
  const indices = new Set(),
    labels = new Set();
  for (let number = 0; number < 10; number++) {
    const visible = await page.locator('[data-crop-pair]').evaluateAll((items) =>
      items.map((el) => ({
        index: el.dataset.cropPair,
        title: el.getAttribute('aria-label'),
      })),
    );
    assert.equal(visible.length, 6);
    for (const item of visible) {
      indices.add(item.index);
      labels.add(item.title);
      assert.match(item.title, /wide-\d\d\.jpg.*detail-\d\d\.jpg/, 'Show the real parent before the crop');
    }
    if (number < 9) await page.locator('#crop-next').click();
  }
  assert.equal(indices.size, 60);
  assert.equal(labels.size, 60);
  assert.ok(await page.locator('#crop-next').isDisabled(), 'Do not expose a 61st result');
  await page.locator('#crop-prev').click();
  assert.equal(await page.locator('[data-crop-pair]').first().getAttribute('data-crop-pair'), '48');
  const lastStarted = await page.evaluate(() => window.__cropQa.started);
  assert.ok(lastStarted >= 5);
  await clearDesk(page);
}

async function verifyFailure(browser, kind) {
  const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce' });
  try {
    if (kind === 'unsupported') {
      await context.addInitScript(() =>
        Object.defineProperty(globalThis, 'Worker', { value: undefined, configurable: true }),
      );
    } else {
      // Only this dedicated failure context substitutes a worker. All successful
      // paths and lifecycle/race tests above use the genuine external module.
      await context.route('**/src/crop-worker.js', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: 'self.onmessage=()=>{throw new Error("Deliberate crop QA worker failure")};',
        }),
      );
    }
    const page = await open(context);
    await importPhotos(page, [master, crop]);
    await page.locator('#crop-start').click();
    await state(page, 'error');
    const message = await page.locator('#crop-status').innerText();
    assert.match(
      message,
      kind === 'unsupported' ? /unavailable|not supported/i : /retry|could not|unavailable/i,
    );
    assert.equal(await page.locator('[data-crop-pair]').count(), 0);
    await choosePlan(page);
    await verifyZip(page, [master, crop]);
  } finally {
    await context.close();
  }
}

let browser;
try {
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {},
  );
  const context = await browser.newContext({
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 900 },
  });
  await controlDelivery(context);
  const bad = [],
    cropRequests = [];
  context.on('request', (req) => {
    const url = new URL(req.url());
    if (cropWorker(url)) cropRequests.push(url.href);
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      (url.origin !== origin || !['GET', 'HEAD'].includes(req.method()))
    )
      bad.push(req.method() + ' ' + url.href);
  });
  context.on('page', (p) => p.on('pageerror', (e) => bad.push(e.message)));
  const page = await open(context);
  await makeFixtures(page);
  const names = [master, crop, copy, unrelated];
  await importPhotos(page, names);
  await choosePlan(page);
  await verifyZip(page, names);
  assert.equal(
    await page.evaluate(() => window.__cropQa.started),
    0,
    'No crop worker during ordinary imports, organization or export',
  );
  assert.deepEqual(cropRequests, [], 'Crop worker code is not fetched before explicit opt-in');

  await page.locator('#crop-start').click();
  await state(page, 'done');
  assert.equal(
    await page.locator('[data-crop-pair]').count(),
    2,
    'Exactly the two master-to-crop pairs are suggested',
  );
  await compareCrop(page);
  await page.waitForFunction(() => document.querySelector('#crop-status').textContent.includes('1 reviewed'));
  await verifyZip(page, names);
  await page.getByRole('button', { name: 'Skip extra byte-identical copies', exact: true }).click();
  await verifyZip(page, [master, crop, unrelated], [copy]);
  console.log(
    'PASS opt-in real EXIF crop, upright non-square region, zoom, mobile, review and exact-only ZIP',
  );
  await verifyLifecycle(page);
  await verifyDense(page);
  assert.deepEqual(bad, [], 'No remote uploads, unexpected methods or runtime errors');
  await context.close();
  const offline = await browser.newContext({ serviceWorkers: 'allow' });
  const cached = await open(offline);
  await cached.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout });
  await offline.setOffline(true);
  const reloaded = await cached.reload();
  assert.ok(reloaded.fromServiceWorker(), 'Offline navigation should use installed app cache');
  await cached.locator('#workspace[aria-busy="false"]').waitFor();
  await cached.locator('#discover').click();
  const pack = await readFile(path.join(root, 'docs', 'crop-practice.zip'));
  const cachedHash = await cached.evaluate(async () => {
    const res = await fetch('./docs/crop-practice.zip');
    if (!res.ok) throw new Error('Missing offline practice ZIP');
    const bytes = await crypto.subtle.digest('SHA-256', await res.arrayBuffer());
    return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
  });
  assert.equal(cachedHash, createHash('sha256').update(pack).digest('hex'));
  const sampleNames = [];
  for (const [name, bytes] of Object.entries(unzipSync(pack))) {
    if (!name.endsWith('.jpg')) continue;
    const simpleName = path.basename(name);
    await writeFile(file(simpleName), bytes);
    sampleNames.push(simpleName);
  }
  assert.equal(sampleNames.length, 4);
  await importPhotos(cached, sampleNames);
  await cached.locator('#crop-start').click();
  await state(cached, 'done');
  assert.equal(
    await cached.locator('[data-crop-pair]').count(),
    2,
    'Both practice pairs can be inspected offline',
  );
  await offline.close();
  console.log('PASS offline practice pack integrity and production crop scan without a network connection');
  await verifyFailure(browser, 'unsupported');
  await verifyFailure(browser, 'worker-error');
  console.log(
    'PASS cancellation/restart, stale result isolation, 60-pair truncation, unsupported/error fallback and working exports',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
