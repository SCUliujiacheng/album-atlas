import { encodeCropPhoto, compareCropPair } from '/src/crop-evidence.js';
import { matchSignatures } from '/src/duplicates.js';

function similarity(first, second) {
  const structure = first.structure.reduce((sum, value, i) => sum + value * second.structure[i], 0);
  const colorDistance = first.colors.reduce((sum, value, i) => sum + Math.abs(value - second.colors[i]), 0);
  return structure - colorDistance / first.colors.length;
}

function wholeFrame(a, b) {
  if (a.digest && a.digest === b.digest) return 'exact';
  return matchSignatures(a.signature, b.signature) ? 'similar' : null;
}

async function evaluate(photos) {
  const { originals, cases } = await (await fetch('/cases.json')).json();
  const labels = new Map(originals.map(({ name, label }) => [name, label]));
  const bank = new Map();
  for (const photo of photos) {
    bank.set(photo.id, await encodeCropPhoto(photo));
  }
  // Pick hard negatives using the earlier whole-frame descriptor only. The crop
  // matcher never participates in choosing the unrelated image for a derivative.
  const mined = [];
  for (const row of cases) {
    if (!row.expected || !labels.has(row.a) || ['bytes', 'jpeg'].includes(row.family)) continue;
    const query = bank.get(row.b).fingerprint.signature;
    let best = -Infinity,
      nearest;
    for (const original of originals) {
      if (original.name === row.a || original.label !== labels.get(row.a)) continue;
      const score = similarity(query, bank.get(original.name).fingerprint.signature);
      if (score > best) {
        best = score;
        nearest = original.name;
      }
    }
    mined.push({ a: nearest, b: row.b, family: 'nearest unrelated original vs crop', expected: false });
  }
  const rows = [...cases, ...mined].map((row) => {
    const a = bank.get(row.a),
      b = bank.get(row.b);
    const baseline = wholeFrame(a.fingerprint, b.fingerprint);
    const hit = baseline ? null : compareCropPair(a, b);
    return {
      ...row,
      baseline,
      crop: hit
        ? {
            originalId: hit.originalId,
            cropId: hit.cropId,
            box: [hit.box.x, hit.box.y, hit.box.w, hit.box.h],
            correlation: hit.correlation,
          }
        : null,
    };
  });
  return { browser: navigator.userAgent, fixtures: bank.size, rows };
}

self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ result: await evaluate(data) });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
