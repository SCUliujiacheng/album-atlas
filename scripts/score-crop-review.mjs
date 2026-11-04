import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const [directory, output] = process.argv.slice(2);
if (!directory || !output)
  throw new Error('Usage: node scripts/score-crop-review.mjs FIXTURE_DIRECTORY NEW_RESULT.json');
const data = resolve(directory);
const scripts = fileURLToPath(new URL('./', import.meta.url));
const root = resolve(scripts, '..');
const manifest = await readFile(join(data, 'cases.json'));
const { cases } = JSON.parse(manifest);
const names = new Set(cases.flatMap((row) => [row.a, row.b]));
if ([...names].some((n) => basename(n) !== n || !/^[\w.-]+\.(jpg|png)$/i.test(n)))
  throw new Error('Invalid fixture filename');
const modules = new Map([
  ['/bench.mjs', join(scripts, 'crop-benchmark-worker.mjs')],
  ...['crop-evidence', 'crop-matcher', 'crop-scan', 'duplicates'].map((n) => [
    '/src/' + n + '.js',
    join(root, 'src', n + '.js'),
  ]),
]);
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (pathname === '/')
      return res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<title>Album Atlas crop evaluation</title>');
    if (pathname === '/cases.json')
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(manifest);
    if (modules.has(pathname))
      return res
        .writeHead(200, { 'Content-Type': 'text/javascript' })
        .end(await readFile(modules.get(pathname)));
    const name = pathname.slice('/fixtures/'.length);
    if (pathname.startsWith('/fixtures/') && names.has(name)) {
      return res
        .writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : 'image/jpeg' })
        .end(await readFile(join(data, 'fixtures', name)));
    }
    return res.writeHead(404).end();
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((done, fail) => {
  server.once('error', fail);
  server.listen(0, '127.0.0.1', done);
});
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const result = await page.evaluate(
    async (names) => {
      const { fingerprint } = await import('/src/duplicates.js');
      const photos = [];
      // The import path derives its existing whole-frame signature from an HTML
      // image. Preserve that signature when sending Blob handles to the crop worker.
      for (const id of names) {
        const response = await fetch('/fixtures/' + encodeURIComponent(id));
        if (!response.ok) throw new Error('Fixture unavailable: ' + id);
        const blob = await response.blob(),
          url = URL.createObjectURL(blob);
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          photos.push({ id, blob, fingerprint: await fingerprint(blob, image) });
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      return new Promise((ok, fail) => {
        const worker = new Worker('/bench.mjs', { type: 'module' });
        worker.onmessage = ({ data }) => {
          worker.terminate();
          if (data.error) fail(new Error(data.error));
          else ok(data.result);
        };
        worker.onerror = (error) => {
          worker.terminate();
          fail(new Error(error.message));
        };
        worker.postMessage(photos);
      });
    },
    [...names],
  );
  await writeFile(output, JSON.stringify(result) + '\n', { flag: 'wx' });
  console.log(
    result.fixtures + ' distinct files, ' + result.rows.length + ' scored pairs. Evidence saved to ' + output,
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
