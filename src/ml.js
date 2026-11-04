// Album Atlas v1. Every photo stores both feature blocks. A zero semantic block
// denotes visual-only extraction, including on devices where the model failed.
export const SEMANTIC_SIZE = 1280;
export const VISUAL_SIZE = 81;
const VECTOR_SIZE = SEMANTIC_SIZE + VISUAL_SIZE;
const SEMANTIC_WEIGHT = 0.86;

export function normalized(values) {
  const array = Array.from(values);
  const norm = Math.sqrt(array.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? array.map(value => value / norm) : array;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return Math.max(-1, Math.min(1, sum));
}

function mean(vectors) {
  const sums = Array(vectors[0].length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < sums.length; i++) sums[i] += vector[i];
  }
  return normalized(sums);
}

function valid(vector, size) {
  return (Array.isArray(vector) || ArrayBuffer.isView(vector)) && vector.length === size && size > 0 &&
    vector.every(Number.isFinite) && vector.some(value => value !== 0);
}

function projectTogether(vectors) {
  if (vectors[0].length !== VECTOR_SIZE) return { rows: vectors.map(normalized), visualOnly: false };
  const visualOnly = vectors.some(vector => !vector.slice(0, SEMANTIC_SIZE).some(value => value !== 0));
  const rows = vectors.map(vector => {
    const visual = normalized(vector.slice(SEMANTIC_SIZE));
    if (visualOnly) return visual;
    const learned = normalized(vector.slice(0, SEMANTIC_SIZE));
    return normalized([...learned.map(v => v * Math.sqrt(SEMANTIC_WEIGHT)), ...visual.map(v => v * Math.sqrt(1 - SEMANTIC_WEIGHT))]);
  });
  return { rows, visualOnly };
}

/** Map a photo to confirmed examples. Scores are cosine similarities, not probabilities. */
export function classify(queryVector, albums = []) {
  const empty = { albumId: null, suggestionId: null, score: 0, margin: 0 };
  if (!valid(queryVector, queryVector?.length)) return empty;
  const candidates = albums.map(album => ({ id: album.id, samples: (album.vectors || []).filter(v => valid(v, queryVector.length)) }))
    .filter(album => album.id != null && album.samples.length > 0);
  if (!candidates.length) return empty;

  // Rank every candidate in one common space, including after a device or backend change.
  const { rows, visualOnly } = projectTogether([queryVector, ...candidates.flatMap(album => album.samples)]);
  const query = rows[0];
  let offset = 1;
  const ranking = candidates.map(album => {
    const samples = rows.slice(offset, offset + album.samples.length);
    offset += samples.length;
    const nearest = samples.map(row => dot(query, row)).sort((a, b) => b - a).slice(0, 2);
    const neighbors = nearest.reduce((sum, x) => sum + x, 0) / nearest.length;
    return { id: album.id, score: 0.75 * neighbors + 0.25 * dot(query, mean(samples)) };
  }).sort((a, b) => b.score - a.score);
  const best = ranking[0];
  const margin = best.score - (ranking[1]?.score ?? 0);
  // With no competing album, demand more evidence before automatically filing.
  const minScore = visualOnly ? 0.77 : 0.50;
  const scoreGate = ranking.length === 1 ? Math.max(minScore, 0.78) : minScore;
  const accepted = best.score >= scoreGate && margin >= (visualOnly ? 0.08 : 0.10);
  return { albumId: accepted ? best.id : null, suggestionId: best.id, score: best.score, margin };
}

/** Deterministic cosine k-means with farthest-first seeds. Indices match the input order. */
export function cluster(vectors, requestedK) {
  if (!vectors.length) return [];
  if (vectors.some(row => !valid(row, vectors[0]?.length))) throw new TypeError('Clustering requires finite, nonzero vectors of equal size.');
  const { rows } = projectTogether(vectors);
  const k = Math.max(1, Math.min(rows.length, Math.trunc(requestedK) || 1));
  if (k === 1) return rows.map(() => 0);
  if (k === rows.length) return rows.map((_, i) => i);
  const center = mean(rows);
  const first = rows.reduce((best, row, i) => dot(row, center) < dot(rows[best], center) ? i : best, 0);
  const seeds = [first];
  const distances = rows.map(row => 1 - dot(row, rows[first]));
  while (seeds.length < k) {
    seeds.forEach(i => { distances[i] = -Infinity; });
    const next = distances.reduce((best, distance, i) => distance > distances[best] ? i : best, 0);
    seeds.push(next);
    for (let i = 0; i < rows.length; i++) distances[i] = Math.min(distances[i], 1 - dot(rows[i], rows[next]));
  }
  let centers = seeds.map(i => rows[i]);
  let labels = [];
  for (let iteration = 0; iteration < 30; iteration++) {
    const buckets = centers.map(() => []);
    const next = rows.map((row, i) => {
      let best = 0, bestScore = -Infinity;
      for (let j = 0; j < k; j++) {
        const score = dot(row, centers[j]);
        if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && buckets[j].length < buckets[best].length)) {
          best = j; bestScore = score;
        }
      }
      buckets[best].push(i);
      return best;
    });
    // Reseed an empty group with the least well represented member of a non-singleton group.
    for (let j = 0; j < k; j++) {
      if (buckets[j].length) continue;
      let move = -1, lowest = Infinity;
      for (let i = 0; i < rows.length; i++) {
        const score = dot(rows[i], centers[next[i]]);
        if (buckets[next[i]].length > 1 && score < lowest) { lowest = score; move = i; }
      }
      const donor = buckets[next[move]];
      donor.splice(donor.indexOf(move), 1);
      next[move] = j;
      buckets[j].push(move);
    }
    if (next.every((value, i) => value === labels[i])) break;
    labels = next;
    centers = buckets.map(bucket => mean(bucket.map(i => rows[i])));
  }
  return labels;
}
