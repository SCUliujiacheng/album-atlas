import test from 'node:test';
import assert from 'node:assert/strict';
import { scanCrops } from '../src/crop-scan.js';
import { encodeCrop, possibleCrop } from '../src/crop-matcher.js';
import { compareCropPair, scanCropPairs } from '../src/crop-evidence.js';

function pixels(box = [0, 0, 64, 64]) {
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const u = box[0] + ((x + 0.5) * box[2]) / 64,
        v = box[1] + ((y + 0.5) * box[3]) / 64;
      rgba.set(
        [
          124 + 68 * Math.cos(u / 8) + 24 * Math.sin(v / 7),
          128 + 69 * Math.sin((u + v) / 7),
          130 + 72 * Math.cos(v / 5),
          255,
        ],
        4 * (y * 64 + x),
      );
    }
  return rgba;
}
const parent = { id: 'parent', crop: encodeCrop(pixels(), 1), fingerprint: { digest: 'a' } };
const child = {
  id: 'child',
  crop: encodeCrop(pixels([4, 11, 50, 50]), 1),
  fingerprint: { digest: 'b' },
};

test('registration reproduces the frozen geometry, color, correlation and local residual evidence', () => {
  // Generated from these same deterministic pixels by the original frozen implementation.
  assert.deepEqual(possibleCrop(child.crop, parent.crop), {
    correlation: 0.9999914592090214, colorDifference: 0.0007065864629112184,
    box: [0.0625, 0.171875, 0.78125, 0.78125],
    maxPatch: 0.0019097403855994344, medianPatch: 0.0013084523379802704,
    container: 'right', kind: 'possible-crop',
  });
  const hit = compareCropPair(child, parent);
  assert.equal(hit.originalId, 'parent');
  assert.equal(hit.cropId, 'child');
  for (const [key, expected] of Object.entries({ x: 4 / 64, y: 11 / 64, w: 50 / 64, h: 50 / 64 }))
    assert.ok(Math.abs(hit.box[key] - expected) < 0.04, key);
  assert.equal(compareCropPair(parent, { ...child, fingerprint: { digest: 'a' } }), null);
  const signature = { aspect: 1, contrast: 0.2, mean: 0.5, colors: [0], structure: [1] };
  assert.equal(
    compareCropPair({ ...parent, fingerprint: { signature } }, { ...child, fingerprint: { signature } }),
    null,
  );
});

test('stable direct pairs stop on the observed 61st match and distinguish exactly 60', () => {
  const records = (a, b) => [
    ...Array.from({ length: a }, (_, i) => ({ ...parent, id: 'a' + i })),
    ...Array.from({ length: b }, (_, i) => ({ ...child, id: 'b' + i })),
  ];
  const dense = scanCropPairs(records(9, 9));
  assert.equal(dense.pairs.length, 60);
  assert.equal(dense.atLeast, 61);
  assert.equal(dense.truncated, true);
  assert.equal(dense.totalPairs, 153);
  assert.ok(dense.examinedPairs < dense.totalPairs);
  assert.deepEqual(
    dense.pairs.map((p) => p.originalId + '/' + p.cropId),
    records(9, 0)
      .flatMap((a) => records(0, 9).map((b) => a.id + '/' + b.id))
      .slice(0, 60),
  );
  const exact = scanCropPairs(records(6, 10));
  assert.equal(exact.pairs.length, 60);
  assert.equal(exact.atLeast, 60);
  assert.equal(exact.truncated, false);
  assert.equal(exact.examinedPairs, 120);
});

test('nested crops do not turn a connected chain into a third unverified pair', () => {
  const records = [
    [0, 0, 64, 64],
    [10, 10, 44, 44],
    [16.875, 16.875, 30.25, 30.25],
  ].map((box, i) => ({
    id: String(i),
    fingerprint: { digest: String(i) },
    crop: encodeCrop(pixels(box), 1),
  }));
  const result = scanCropPairs(records);
  assert.deepEqual(
    result.pairs.map((p) => [p.originalId, p.cropId]),
    [
      ['0', '1'],
      ['1', '2'],
    ],
  );
  assert.equal(result.examinedPairs, 3);
});

function installWorker(t, implementation) {
  for (const [key, value] of Object.entries({ Worker: implementation, OffscreenCanvas: class {} })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
}

function localPhotos() {
  return ['a', 'b'].map((id) => ({
    id,
    blob: new Blob([id]),
    thumb: new Blob(['lossy']),
    vector: [99],
    url: 'blob:hidden',
  }));
}

test('abort terminates the worker, removes handlers and ignores already queued progress or results', async (t) => {
  let worker;
  installWorker(
    t,
    class {
      constructor() {
        worker = this;
      }
      postMessage(data) {
        this.input = data;
      }
      terminate() {
        this.stopped = true;
      }
    },
  );
  const control = new AbortController(),
    updates = [],
    photos = localPhotos();
  const pending = scanCrops(photos, {
    signal: control.signal,
    onProgress: (data) => updates.push(data),
  });
  assert.equal(worker.input[0].blob, photos[0].blob);
  assert.deepEqual(Object.keys(worker.input[0]).sort(), ['blob', 'fingerprint', 'id']);
  const queued = worker.onmessage;
  queued({ data: { type: 'progress', progress: { phase: 'encoding', completed: 0, total: 2 } } });
  control.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(worker.stopped);
  assert.equal(worker.onmessage, null);
  queued({ data: { type: 'progress', progress: { phase: 'encoding', completed: 1, total: 2 } } });
  queued({ data: { type: 'result', result: { pairs: ['stale'] } } });
  assert.equal(updates.length, 1);
  await assert.rejects(scanCrops(photos, { signal: control.signal }), { name: 'AbortError' });
});

test('worker errors, unavailable capabilities and unsupported inputs have explicit outcomes', async (t) => {
  let worker;
  installWorker(
    t,
    class {
      constructor() {
        worker = this;
      }
      postMessage() {}
      terminate() {
        this.stopped = true;
      }
    },
  );
  const photos = localPhotos();
  await assert.rejects(scanCrops(Array(301).fill(photos[0])), RangeError);
  await assert.rejects(scanCrops([photos[0], photos[0]]), TypeError);
  const pending = scanCrops(photos);
  worker.onmessage({
    data: { type: 'error', name: 'NotSupportedError', message: 'No worker 2D canvas' },
  });
  await assert.rejects(pending, { name: 'NotSupportedError' });
  assert.ok(worker.stopped);
  const retry = scanCrops(photos);
  const result = { pairs: [], truncated: false, examinedPairs: 1, totalPairs: 1, atLeast: 0 };
  worker.onmessage({ data: { type: 'result', result } });
  assert.deepEqual(await retry, result);
  assert.ok(worker.stopped);
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
  await assert.rejects(scanCrops(photos), { name: 'NotSupportedError' });
});
