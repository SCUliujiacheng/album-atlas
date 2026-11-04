import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, cluster, SEMANTIC_SIZE, VISUAL_SIZE } from '../src/ml.js';
import { visualDescriptor } from '../src/embedding.js';

const album = (id, ...vectors) => ({ id, vectors });
const learned = (index, appearance) => {
  const model = Array(SEMANTIC_SIZE).fill(0), visual = Array(VISUAL_SIZE).fill(0);
  if (index >= 0) model[index] = 1;
  visual[appearance] = 1;
  return [...model, ...visual];
};

test('classification is scale invariant, leaves ambiguous or unfamiliar photos for review', () => {
  const examples = [album('north', [6, 0, 0], [1, 0, 0]), album('south', [0, 3, 0])];
  assert.equal(classify([2, 0, 0], examples).albumId, 'north');
  assert.equal(classify([1, 1, 0], examples).albumId, null);
  assert.equal(classify([0, 0, 1], examples).albumId, null);
  assert.equal(classify([0, 0, 1], examples.slice(0, 1)).albumId, null);
  assert.equal(classify([0, 0, 1], []).suggestionId, null);
  assert.equal(classify([0, 0], [album('invalid', [NaN, 2])]).suggestionId, null);
  assert.equal(classify([1, 0], [album('bad-size', [7]), album('ok', [3, 0])]).albumId, 'ok');
});

test('visual-only records trigger the same common space for every candidate', () => {
  const query = learned(2, 1);
  const conflicting = [album('appearance', learned(-1, 1)), album('semantics', learned(2, 7))];
  assert.equal(classify(query, conflicting).albumId, 'appearance');
  assert.equal(classify(learned(-1, 7), conflicting).albumId, 'semantics');
  assert.equal(classify(query, [album('semantic', learned(2, 7)), album('other', learned(7, 1))]).albumId, 'semantic');
});

test('clustering is reproducible, separates two families and handles degenerate inputs', () => {
  const rows = [[5, 1], [6, 1], [0, 6], [1, 6]];
  const labels = cluster(rows, 2);
  assert.deepEqual(labels, cluster(rows, 2));
  assert.equal(labels[0], labels[1]); assert.equal(labels[2], labels[3]); assert.notEqual(labels[0], labels[2]);
  assert.deepEqual(cluster([], 3), []);
  assert.deepEqual(cluster(rows, 0), [0, 0, 0, 0]);
  assert.deepEqual(cluster(rows, 99), [0, 1, 2, 3]);
  const equal = cluster(Array.from({ length: 9 }, () => [1, 1]), 3);
  assert.deepEqual([0, 1, 2].map(k => equal.filter(v => v === k).length), [3, 3, 3]);
  assert.throws(() => cluster([[1], [2, NaN]], 2), TypeError);
});

test('visual descriptor handles gray, uniform colors and a one-pixel source', () => {
  for (const value of [0, 127, 255]) {
    const vec = visualDescriptor([value, value, value, 255], 1, 1);
    assert.equal(vec.length, VISUAL_SIZE);
    assert.ok(vec.every(Number.isFinite));
    assert.ok(Math.abs(vec.reduce((sum, x) => sum + x * x, 0) - 1) < 1e-8);
  }
  const red = visualDescriptor([255, 0, 0, 255], 1, 1), blue = visualDescriptor([0, 0, 255, 255], 1, 1);
  assert.ok(red.reduce((sum, x, i) => sum + x * blue[i], 0) < 0.4);
});
