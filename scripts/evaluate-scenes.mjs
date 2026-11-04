// Usage: node scripts/evaluate-scenes.mjs /path/to/prepared-data calibration|test [records.json]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const [directory, split, output] = process.argv.slice(2);
if (!directory || !['calibration', 'test'].includes(split)) throw new Error('Expected a dataset directory and calibration or test.');
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'))
  .filter(row => row.split === 'reference' || row.split === split);
if (manifest.some(row => !/^images\/[a-z\d_.-]+\.jpg$/i.test(row.path))) throw new Error('Invalid manifest image path');
const files = new Set(manifest.map(row => row.path));

const server = await startServer({ port: 0 });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await page.route('**/scene-fixtures/**', async route => {
    const key = decodeURIComponent(new URL(route.request().url()).pathname.slice('/scene-fixtures/'.length));
    if (files.has(key)) await route.fulfill({ path: join(directory, key), contentType: 'image/jpeg' });
    else await route.abort();
  });
  // A neutral same-origin document keeps the app UI and its demo samples out of the evaluation.
  await page.route('**/evaluate.html', route => route.fulfill({ contentType: 'text/html', body: '<title>Scene evaluation</title>' }));
  await page.goto('http://127.0.0.1:' + server.address().port + '/evaluate.html');
  const { records, millisecondsPerPhoto } = await page.evaluate(async rows => {
    const { extractEmbedding } = await import('/src/embedding.js');
    const { classify } = await import('/src/ml.js');
    const albums = new Map(), queries = [];
    const start = performance.now();
    for (const row of rows) {
      const img = new Image();
      img.src = '/scene-fixtures/' + row.path;
      await img.decode();
      const { vector } = await extractEmbedding(img, { requiredModel: true });
      if (row.split === 'reference') {
        if (!albums.has(row.label)) albums.set(row.label, { id: row.label, vectors: [] });
        albums.get(row.label).vectors.push(vector);
      } else queries.push({ ...row, vector });
    }
    const references = [...albums.values()];
    return {
      records: queries.map(({ vector, ...row }) => ({ ...row, ...classify(vector, references) })),
      millisecondsPerPhoto: Math.round((performance.now() - start) / rows.length),
    };
  }, manifest);
  const known = records.filter(r => r.known), unknown = records.filter(r => !r.known);
  const assigned = records.filter(r => r.albumId != null);
  const summary = {
    split, referencePhotos: manifest.length - records.length, knownPhotos: known.length, unknownPhotos: unknown.length,
    nearestCorrectKnown: known.filter(r => r.suggestionId === r.label).length,
    assigned: assigned.length, assignedCorrect: assigned.filter(r => r.known && r.albumId === r.label).length,
    knownAssignedWrong: known.filter(r => r.albumId != null && r.albumId !== r.label).length,
    unknownAssigned: unknown.filter(r => r.albumId != null).length,
    knownReview: known.filter(r => r.albumId == null).length,
    unknownReview: unknown.filter(r => r.albumId == null).length, millisecondsPerPhoto,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (output) await writeFile(output, JSON.stringify({ summary, records }, null, 2) + '\n');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
