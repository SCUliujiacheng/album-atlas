import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSignature, matchSignatures, duplicateGroups, sha256 } from '../src/duplicates.js';

function drawing(offset = [0, 0, 0], contrast = 1, flat = false) {
  const rgba = new Uint8ClampedArray(32 * 32 * 4);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const light = flat ? 128 : 128 + 55 * Math.sin(x / 5) + 28 * Math.cos(y / 7);
      rgba.set([...offset.map((v) => 128 + (light - 128) * contrast + v), 255], (32 * y + x) * 4);
    }
  return imageSignature(rgba, 32, 32);
}

test('SHA-256 uses original bytes and separates different bytes with the same filename', async () => {
  assert.equal(
    await sha256(new Blob(['abc'])),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.notEqual(await sha256(new Blob(['abc'])), await sha256(new Blob(['ABC'])));
});

test('visual matches tolerate contrast, reject different colors, shapes and uninformative frames', () => {
  assert.ok(matchSignatures(drawing(), drawing([0, 0, 0], 0.8)).correlation > 0.98);
  assert.equal(matchSignatures(drawing([34, -8, -35]), drawing([-34, 8, 35])), null);
  assert.equal(matchSignatures(drawing(), { ...drawing(), aspect: 1.8 }), null);
  assert.equal(matchSignatures(drawing([0, 0, 0], 1, true), drawing([0, 0, 0], 1, true)), null);
});

test('group evidence distinguishes exact bytes and similar previews; every file starts included', () => {
  const photo = (id, digest, signature) => ({
    id,
    width: 256,
    height: 256,
    blob: new Blob(['data']),
    fingerprint: { digest, signature },
  });
  const files = [
    photo('a', 'one', drawing()),
    photo('b', 'two', drawing([0, 0, 0], 0.9)),
    photo('c', 'two', drawing([0, 0, 0], 0.9)),
    photo('x', 'four', drawing([33, -9, -35])),
  ];
  assert.deepEqual(
    duplicateGroups(files).map((g) => g.map((m) => [m.photo.id, m.kind, m.withId])),
    [
      [
        ['a', 'anchor', null],
        ['b', 'similar', 'a'],
        ['c', 'exact', 'b'],
      ],
    ],
  );
  assert.ok(files.every((p) => !p.skipExport));
  assert.deepEqual(duplicateGroups([{ id: 'old-draft' }]), []);
});
