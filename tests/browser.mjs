import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { verifyWorkerPaths } from './worker-paths.mjs';
import { unzipSync } from '../vendor/fflate.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const demoDir = path.join(root, 'assets', 'demo');
const capture = process.argv.includes('--screenshots');
const issues = [];
const modelFiles = new Set();
const desktop = { width: 1360, height: 900 };
const mobile = { width: 390, height: 844 };
const scratch = await mkdtemp(path.join(tmpdir(), 'album-atlas-browser-'));
const server = await startServer({ port: 0 });
const origin = 'http://127.0.0.1:' + server.address().port;
let browser;

function monitor(page) {
  page.on('pageerror', error => issues.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') issues.push(message.text());
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
        issues.push('Unexpected network request: ' + request.method() + ' ' + url.href);
      }
    }
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400) issues.push(response.status() + ' ' + url.pathname);
    if (response.ok() && url.pathname.includes('/vendor/mobilenet/')) modelFiles.add(url.pathname);
  });
}

async function layoutFits(page) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert.ok(fits, 'The screen must fit without horizontal scrolling');
}
async function ready(page) {
  await page.locator('#workspace[aria-busy="false"]').waitFor({ timeout: 120_000 });
}
const button = (page, name) => page.getByRole('button', { name, exact: true });

async function chooseFiles(page, control, files) {
  const opened = page.waitForEvent('filechooser');
  await control.click();
  await (await opened).setFiles(files);
  await ready(page);
}

async function checkExport(page, expected, album, movedPhoto, skipped = []) {
  const started = page.waitForEvent('download');
  await button(page, 'Download ZIP').click();
  const download = await started;
  assert.match(download.suggestedFilename(), /\.zip$/i);
  const files = unzipSync(new Uint8Array(await readFile(await download.path())));
  const manifest = JSON.parse(new TextDecoder().decode(files['album-atlas.json']));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.photos.map(item => item.original).sort(), [...expected.keys()].sort());
  assert.deepEqual((manifest.skippedCopies || []).map(item => item.original).sort(), [...skipped].sort());
  assert.equal(Object.keys(files).length, expected.size + 1);
  if (album) assert.ok(manifest.photos.some(item => item.path.startsWith(album + '/')));
  if (movedPhoto) {
    const moved = manifest.photos.find(item => item.original === movedPhoto);
    assert.ok(moved.path.startsWith(album + '/'), 'Manual reassignment must appear in the archive');
  }
  for (const item of manifest.photos) {
    const original = await readFile(expected.get(item.original));
    assert.equal(item.bytes, original.length);
    assert.deepEqual(Buffer.from(files[item.path]), original, 'Archive must preserve bytes of ' + item.original);
  }
}

try {
  const channel = process.env.PLAYWRIGHT_CHANNEL;
  browser = await chromium.launch(channel ? { channel } : {});
  // A clean, service-worker-free context ensures the privacy check observes first-load asset requests.
  const context = await browser.newContext({ viewport: desktop, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  monitor(page);
  await page.goto(origin);
  await ready(page);
  assert.match(await page.title(), /Album Atlas/);
  await page.locator('#language').click();
  await page.reload();
  await button(page, 'Match albums').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'Language preference survives reload');
  await page.evaluate(() => Promise.all([...document.querySelectorAll('.print img')].map(img => img.decode())));
  await layoutFits(page);
  if (capture) {
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'docs/workbench.png'), fullPage: true });
  }
  await page.setViewportSize(mobile);
  await layoutFits(page);
  if (capture) await page.screenshot({ path: path.join(tmpdir(), 'album-atlas-mobile.png') });
  await page.setViewportSize(desktop);

  await page.locator('#demo').click();
  await ready(page);
  if (!await page.locator('#review').isVisible()) await button(page, 'Match albums').click();
  await page.locator('#review .photo-card').first().waitFor();
  const demoNames = await page.locator('#review .photo-name').allTextContents();
  assert.equal(demoNames.length, 6);
  assert.equal(new Set(demoNames).size, 6);
  assert.ok(modelFiles.has('/vendor/mobilenet/model.json'));
  assert.ok([...modelFiles].some(name => name.endsWith('.bin')));
  const kind = await page.evaluate(async () => {
    const { extractEmbedding } = await import('./src/embedding.js');
    return (await extractEmbedding(document.querySelector('.print img'), { requiredModel: true })).kind;
  });
  assert.equal(kind, 'mobilenet', 'A genuine inference must work without the visual-only fallback');
  await page.locator('.photo-preview').first().click();
  assert.ok(await page.locator('#photo-dialog').isVisible());
  await button(page, 'Close preview').click();
  if (!await page.locator('.uncertain').count()) {
    await page.locator('#review select').first().selectOption({ label: 'Needs review' });
  }
  const reviewCount = await page.locator('.uncertain .photo-card').count();
  await page.locator('.uncertain .accept-suggestion').first().click();
  assert.equal(await page.locator('.uncertain .photo-card').count(), reviewCount - 1);
  await button(page, 'Undo last edit').click();
  assert.equal(await page.locator('.uncertain .photo-card').count(), reviewCount);
  assert.ok(await button(page, 'Download ZIP').isDisabled(), 'Unreviewed photos block export');
  await button(page, 'Keep as a separate album').click();
  assert.ok(await button(page, 'Download ZIP').isEnabled());
  await page.locator('#discover').click();
  if (!await page.locator('.plans').isVisible()) await button(page, 'Generate plans').click();
  await page.locator('.plan').first().waitFor();
  assert.ok(await page.locator('.plan').count() >= 2);
  await page.locator('.plan').first().click();
  await page.locator('#review .edit-name').first().waitFor();
  await page.setViewportSize(mobile);
  await layoutFits(page);
  await page.setViewportSize(desktop);
  if (capture) {
    const clip = await page.evaluate(() => {
      const top = window.scrollY + document.querySelector('#plans').getBoundingClientRect().top - 18;
      const bottom = window.scrollY + document.querySelector('#review').getBoundingClientRect().bottom + 12;
      return { x: 0, y: Math.floor(top), width: window.innerWidth, height: Math.ceil(bottom - top) };
    });
    await page.screenshot({ path: path.join(root, 'docs/review.png'), clip, fullPage: true });
  }
  const firstName = page.locator('#review .edit-name').first();
  await firstName.fill('Travel selects');
  await firstName.press('Tab');
  const destination = await page.locator('#review select').first().locator('option', { hasText: 'Travel selects' }).getAttribute('value');
  const outside = page.locator('#review .group').nth(1).locator('select').first();
  const movedPhoto = (await outside.getAttribute('aria-label')).replace('Move photo ', '');
  await outside.selectOption(destination);
  await checkExport(page, new Map(demoNames.map(name => [name, path.join(demoDir, name)])), 'Travel selects', movedPhoto);
  console.log('PASS demo, discovery plans, preview, rename, reassignment and byte-exact ZIP');

  await page.locator('#reset').click();
  await page.locator('#clear-confirm').click();
  await page.locator('#known').click();
  const referenceRoot = path.join(scratch, 'Reference albums');
  for (const [name, file] of [['Coast', 'shore-01.jpg'], ['Trees', 'forest-01.jpg']]) {
    await mkdir(path.join(referenceRoot, name), { recursive: true });
    await copyFile(path.join(demoDir, file), path.join(referenceRoot, name, file));
  }
  await chooseFiles(page, button(page, 'Import album folders'), referenceRoot);
  assert.deepEqual((await page.locator('.refs .album-mark').allTextContents()).sort(), ['Coast', 'Trees']);
  const inputFiles = new Map(['shore-01.jpg', 'forest-01.jpg'].map(name => [name, path.join(demoDir, name)]));
  await chooseFiles(page, button(page, 'Choose photos'), [...inputFiles.values()]);
  await button(page, 'Match albums').click();
  await page.locator('#review .photo-card').first().waitFor();
  assert.equal(await page.locator('#review .photo-card').count(), 2);
  assert.equal(await page.locator('#review .uncertain').count(), 0, 'Exact reference matches should file automatically');
  assert.ok(await button(page, 'Download ZIP').isEnabled());
  await checkExport(page, inputFiles, 'Coast');
  assert.deepEqual(issues, []);
  console.log('PASS real folder import, individual image import, local model assets, no photo uploads, responsive layouts and ZIP contents');

  const renamed = 'Saved on this device';
  await page.locator('#review .edit-name').first().fill(renamed);
  await page.locator('#review .edit-name').first().press('Tab');
  await page.locator('#draft-tools summary').click();
  await button(page, 'Save current draft').click();
  await page.waitForFunction(() => !document.querySelector('#draft-load').disabled);
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('#review').count(), 0, 'Personal drafts only load on request');
  await page.locator('#draft-tools summary').click();
  await button(page, 'Restore draft').click();
  await page.locator('#review .photo-card').first().waitFor();
  await page.locator('#review .photo-card img').first().evaluate(img => img.decode());
  assert.equal(await page.locator('#review .edit-name').first().inputValue(), renamed);
  await checkExport(page, inputFiles, renamed);
  await page.locator('#review .edit-name').first().fill('Unexported change');
  await page.locator('#review .edit-name').first().press('Tab');
  await page.locator('#discover').click();
  await button(page, 'Generate plans').click();
  await page.locator('.plan').first().click();
  const otherExport = page.waitForEvent('download');
  await button(page, 'Download ZIP').click();
  await otherExport;
  const protectedEdits = await page.evaluate(() => {
    const leaving = new Event('beforeunload', {cancelable:true});
    window.dispatchEvent(leaving);
    return leaving.defaultPrevented;
  });
  assert.ok(protectedEdits, 'Exporting one workflow must protect unsaved edits in the other');
  page.once('dialog', dialog => dialog.accept());
  await button(page, 'Delete saved draft').click();
  await page.waitForFunction(() => document.querySelector('#draft-clear').disabled &&
    document.querySelector('#draft-status').textContent.includes('No draft'));
  assert.equal(await page.locator('#review .photo-card').count(), 2, 'Deleting a saved copy keeps the working set');
  console.log('PASS opt-in draft save, explicit restore after reload, original bytes, and deletion');

  const copies = await context.newPage();
  monitor(copies);
  await copies.goto(origin);
  await ready(copies);
  await copies.locator('#discover').click();
  const originals = new Map([['shore-01.jpg',path.join(demoDir,'shore-01.jpg')],['city-01.jpg',path.join(demoDir,'city-01.jpg')]]);
  const exactPath = path.join(scratch,'exact-copy.jpg'), smallerPath = path.join(scratch,'smaller-copy.jpg');
  await copyFile(originals.get('shore-01.jpg'),exactPath);
  const resized = await copies.evaluate(async () => {
    const img = new Image(); img.src = './assets/demo/shore-01.jpg'; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = 260; canvas.height = Math.round(img.height*260/img.width);
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',0.65).split(',')[1];
  });
  await writeFile(smallerPath,Buffer.from(resized,'base64'));
  const all = new Map([...originals,['exact-copy.jpg',exactPath],['smaller-copy.jpg',smallerPath]]);
  await chooseFiles(copies,button(copies,'Choose photos'),[...all.values()]);
  const panel = copies.locator('#copies');
  await panel.waitFor({timeout:5000});
  assert.equal(await panel.locator('.copy-entry').count(),3);
  assert.match(await panel.textContent(),/SHA-256/);
  assert.match(await panel.textContent(),/correlation/i);
  await button(copies,'Generate plans').click();
  await copies.locator('.plan').first().click();
  await checkExport(copies,all);
  await panel.getByRole('button',{name:'Skip extra byte-identical copies'}).click();
  if (process.argv.includes('--copies-screenshot'))
    await panel.screenshot({path:path.join(root,'docs/duplicate-review.png')});
  await copies.setViewportSize(mobile);
  await layoutFits(copies);
  await copies.setViewportSize(desktop);
  await panel.getByRole('button',{name:'Skip smaller-copy.jpg'}).click();
  assert.ok(await panel.getByRole('button',{name:'Skip shore-01.jpg'}).isDisabled());
  assert.equal(await copies.locator('#review .photo-card').count(),2);
  await checkExport(copies,originals,null,null,['exact-copy.jpg','smaller-copy.jpg']);
  await copies.locator('#draft-tools summary').click();
  await button(copies,'Save current draft').click();
  await copies.waitForFunction(() => document.querySelector('#draft-status').textContent.includes('One saved'));
  await copies.reload(); await ready(copies);
  await copies.locator('#draft-tools summary').click(); await button(copies,'Restore draft').click();
  await panel.getByRole('button',{name:'Include exact-copy.jpg'}).waitFor();
  await checkExport(copies,originals,null,null,['exact-copy.jpg','smaller-copy.jpg']);
  await panel.getByRole('button',{name:'Include exact-copy.jpg'}).click();
  assert.equal(await copies.locator('#review .photo-card').count(),3);
  await panel.getByRole('button',{name:'Include all again'}).click();
  await checkExport(copies,all);
  // v1.0 drafts had the original blobs and group assignments, but no fingerprints or skip flags.
  await copies.evaluate(() => new Promise((resolve,reject) => {
    const request = indexedDB.open('album-atlas-workspace-v1',1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('saved','readwrite');
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => { db.close(); resolve(); };
      const table = transaction.objectStore('saved'), item = table.get('current');
      item.onsuccess = () => {
        const legacy = item.result;
        for (const p of legacy.photos) { delete p.fingerprint; delete p.skipExport; }
        table.put(legacy,'current');
      };
    };
  }));
  await copies.reload(); await ready(copies);
  await copies.locator('#draft-tools summary').click(); await button(copies,'Restore draft').click();
  await panel.getByRole('button',{name:'Skip extra byte-identical copies'}).waitFor();
  await checkExport(copies,all);
  await copies.close();
  console.log('PASS exact/visual duplicate evidence, reversible export decisions, preserved bytes and saved draft');

  const offline = await browser.newContext({ viewport: desktop, serviceWorkers: 'allow' });
  const cachedPage = await offline.newPage();
  monitor(cachedPage);
  await cachedPage.goto(origin);
  await cachedPage.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {timeout: 120_000});
  const servedFromWorker = new Set();
  cachedPage.on('response', response => {
    if (response.fromServiceWorker()) servedFromWorker.add(new URL(response.url()).pathname);
  });
  await offline.setOffline(true);
  const reload = await cachedPage.reload();
  assert.ok(reload.fromServiceWorker(), 'The installed service worker must handle offline navigation');
  await ready(cachedPage);
  await cachedPage.locator('#demo').click();
  await cachedPage.locator('#review .photo-card').first().waitFor({timeout: 120_000});
  assert.equal(await cachedPage.locator('#review .photo-card').count(), 6);
  const offlineModel = await cachedPage.evaluate(async () => {
    const { extractEmbedding, inferenceDiagnostics } = await import('./src/embedding.js');
    const { kind } = await extractEmbedding(document.querySelector('.print img'), {requiredModel:true});
    return { kind, location: inferenceDiagnostics().location };
  });
  assert.deepEqual(offlineModel, { kind: 'mobilenet', location: 'worker' }, 'Offline inference must use the cached worker and model');
  assert.ok(servedFromWorker.has('/vendor/mobilenet/model.json'));
  assert.ok([...servedFromWorker].some(url => url.startsWith('/vendor/mobilenet/') && url.endsWith('.bin')));
  await offline.close();
  assert.deepEqual(issues, []);
  console.log('PASS installed service worker, offline navigation, cached weights and real offline inference');
  await verifyWorkerPaths(browser, origin);
  console.log('PASS concurrent worker inference, fallback without Workers/OffscreenCanvas, runtime failure and strict model semantics');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
