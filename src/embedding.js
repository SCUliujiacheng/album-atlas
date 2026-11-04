import { normalized, SEMANTIC_SIZE } from './ml.js';

const RUNTIME = new URL('../vendor/tfjs/tf.es2017.min.js', import.meta.url);
const WEIGHTS = new URL('../vendor/mobilenet/model.json', import.meta.url);
let loading;

function getModel() {
  if (!loading) loading = (async () => {
    await import(RUNTIME.href);
    const tf = globalThis.tf;
    // Use GPU acceleration where the browser offers it. The CPU backend keeps the
    // same learned feature space on devices without WebGL or cross-origin isolation.
    const accelerated = await tf.setBackend('webgl').catch(() => false);
    if (!accelerated && !await tf.setBackend('cpu')) throw new Error('TensorFlow.js backends unavailable');
    const model = await tf.loadGraphModel(WEIGHTS.href);
    return { model, tf };
  })();
  return loading;
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
      const { tf, model } = await getModel();
      const frame = raster(image, 224);
      const output = tf.tidy(() => {
        // The graph itself converts RGB in [0, 1] to the network's [-1, 1] range.
        const pixels = tf.browser.fromPixels(frame, 3).toFloat().div(255).expandDims(0);
        return model.predict(pixels);
      });
      try {
        const learned = await output.data();
        if (learned.length !== SEMANTIC_SIZE || !learned.every(Number.isFinite) || !learned.some(v => v !== 0)) {
          throw new Error('Model returned an invalid embedding');
        }
        return { vector: [...normalized(learned), ...visual], kind: 'mobilenet' };
      } finally { output.dispose(); }
    } catch (error) {
      if (requiredModel) throw error;
    }
  }
  return { vector: [...Array(SEMANTIC_SIZE).fill(0), ...visual], kind: 'visual' };
}
