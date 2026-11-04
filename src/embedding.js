import { normalized, SEMANTIC_SIZE } from './ml.js';
import { runModel } from './model-runtime.js';

let worker, watchdog, workerFailure = '', nextId = 0;
const pending = new Map();
let diagnostics = { location: 'idle', backend: null };
export const inferenceDiagnostics = () => ({ ...diagnostics, workerFailure });

function disableWorker(error) {
  workerFailure = error.message || 'The inference worker failed';
  clearTimeout(watchdog);
  worker?.terminate();
  worker = undefined;
  for (const task of pending.values()) task.reject(error);
  pending.clear();
}

function watchProgress() {
  clearTimeout(watchdog);
  if (pending.size) watchdog = setTimeout(() => disableWorker(new Error('Inference worker did not respond')), 45_000);
}

function workerModel(frame) {
  if (!worker) {
    worker = new Worker(new URL('./embed-worker.js', import.meta.url), { type: 'module', name: 'Album Atlas inference' });
    worker.onerror = event => {
      event.preventDefault();
      disableWorker(new Error(event.message || 'The inference worker could not start'));
    };
    worker.onmessageerror = () => disableWorker(new Error('The inference worker returned an unreadable message'));
    worker.onmessage = ({ data }) => {
      const task = pending.get(data.id);
      if (!task) return;
      if (data.error) { disableWorker(new Error(data.error)); return; }
      pending.delete(data.id);
      watchProgress();
      task.resolve(data);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    if (pending.size === 1) watchProgress();
    try {
      const rgba = frame.data.buffer;
      worker.postMessage({ id, rgba, width: frame.width, height: frame.height }, [rgba]);
    } catch (error) { disableWorker(error); }
  });
}

function raster(image, size) {
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  if (!(width > 0 && height > 0)) throw new TypeError('A decoded image with nonzero dimensions is required.');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  return context.getImageData(0, 0, size, size);
}

// Combine a hue / neutral histogram, 4×4 spatial color, luminance, and edge directions.
// The global blocks preserve coarse appearance when a subject moves within the frame.
export function visualDescriptor(rgba, width, height) {
  const color = Array(17).fill(0), grid = Array(48).fill(0), cellCounts = Array(16).fill(0);
  const light = Array(8).fill(0), edges = Array(8).fill(0), luminance = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, p = i * 4;
    const r = rgba[p] / 255, g = rgba[p + 1] / 255, b = rgba[p + 2] / 255;
    const high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
    const lum = luminance[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const colorWeight = Math.min(1, delta / 0.28);
    color[12 + Math.min(4, Math.floor(lum * 5))] += 1 - colorWeight;
    if (delta > 0) {
      const sector = high === r ? (g - b) / delta : high === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      const hue = ((sector * 2) % 12 + 12) % 12, bin = Math.floor(hue), fraction = hue - bin;
      color[bin] += (1 - fraction) * colorWeight;
      color[(bin + 1) % 12] += fraction * colorWeight;
    }
    light[Math.min(7, Math.floor(lum * 8))]++;
    const cell = Math.floor(y * 4 / height) * 4 + Math.floor(x * 4 / width);
    cellCounts[cell]++;
    grid[cell * 3] += r - 0.5; grid[cell * 3 + 1] += g - 0.5; grid[cell * 3 + 2] += b - 0.5;
  }
  for (let i = 0; i < grid.length; i++) grid[i] /= cellCounts[Math.floor(i / 3)] || 1;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, gx = luminance[i + 1] - luminance[i - 1], gy = luminance[i + width] - luminance[i - width];
    const orientation = (Math.atan2(gy, gx) / Math.PI + 1) % 1;
    edges[Math.floor(orientation * 8)] += Math.hypot(gx, gy);
  }
  const blocks = [[color.map(Math.sqrt), 0.50], [grid, 0.28], [light.map(Math.sqrt), 0.14], [edges.map(Math.sqrt), 0.08]];
  return normalized(blocks.flatMap(([block, weight]) => normalized(block).map(x => x * Math.sqrt(weight))));
}

/** All asset URLs resolve against this installation. Photos only enter local canvas/tensor memory. */
export async function extractEmbedding(image, { forceVisual = false, requiredModel = false } = {}) {
  const thumb = raster(image, 48);
  const visual = visualDescriptor(thumb.data, thumb.width, thumb.height);
  if (!forceVisual) {
    try {
      let result;
      if (!workerFailure && typeof Worker !== 'function') workerFailure = 'Web Workers are unavailable';
      if (!workerFailure) {
        try { result = await workerModel(raster(image, 224)); }
        catch (error) { if (!workerFailure) disableWorker(error); }
      }
      const location = result ? 'worker' : 'main';
      // Transfer detaches the worker-bound pixels. Re-rasterize from the retained
      // source only when the worker failed or its platform API is unavailable.
      result ??= await runModel(raster(image, 224));
      diagnostics = { location, backend: result.backend };
      return { vector: [...result.learned, ...visual], kind: 'mobilenet' };
    } catch (error) {
      diagnostics = { location: 'visual', backend: null, modelError: error.message };
      if (requiredModel) throw error;
    }
  }
  if (forceVisual) diagnostics = { location: 'visual', backend: null, forced: true };
  return { vector: [...Array(SEMANTIC_SIZE).fill(0), ...visual], kind: 'visual' };
}
