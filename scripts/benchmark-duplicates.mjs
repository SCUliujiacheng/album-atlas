// Browser half of benchmark-duplicates.py. It uses the shipped extraction and matching code.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const directory = process.argv[2];
const cases = JSON.parse(await readFile(path.join(directory, 'cases.json'), 'utf8'));
const names = [...new Set(cases.flatMap((row) => [row.a, row.b]))];
const allowed = new Set(names);
const server = await startServer({ port: 0 });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.route('**/eval.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Copy benchmark</title>' }),
  );
  await page.route('**/fixture/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice('/fixture/'.length);
    if (!allowed.has(name)) return route.abort();
    return route.fulfill({
      path: path.join(directory, name),
      contentType: name.endsWith('.png') ? 'image/png' : 'image/jpeg',
    });
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/eval.html');
  const results = await page.evaluate(
    async ({ names, cases }) => {
      const { fingerprint, matchSignatures } = await import('/src/duplicates.js');
      const images = new Map();
      for (const name of names) {
        const blob = await (await fetch('/fixture/' + name)).blob();
        const url = URL.createObjectURL(blob),
          image = new Image();
        try {
          image.src = url;
          await image.decode();
          images.set(name, await fingerprint(blob, image));
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      return cases.map(({ a, b }) => {
        const left = images.get(a),
          right = images.get(b);
        if (left.digest && left.digest === right.digest) return 'exact';
        return matchSignatures(left.signature, right.signature) ? 'similar' : null;
      });
    },
    { names, cases },
  );
  await writeFile(path.join(directory, 'atlas.json'), JSON.stringify(results));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
