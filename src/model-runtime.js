import { normalized, SEMANTIC_SIZE } from './ml.js';

const RUNTIME = new URL('../vendor/tfjs/tf.es2017.min.js', import.meta.url);
const WEIGHTS = new URL('../vendor/mobilenet/model.json', import.meta.url);
let loading;

function getModel() {
  if (!loading) loading = (async () => {
    await import(RUNTIME.href);
    const tf = globalThis.tf;
    const accelerated = await tf.setBackend('webgl').catch(() => false);
    if (!accelerated && !await tf.setBackend('cpu')) throw new Error('TensorFlow.js backends unavailable');
    return { tf, model: await tf.loadGraphModel(WEIGHTS.href) };
  })();
  return loading;
}

// Both realms use precisely the same 224×224 raster, graph and normalization.
export async function runModel(frame) {
  const { tf, model } = await getModel();
  const result = tf.tidy(() => {
    const pixels = tf.browser.fromPixels(frame, 3).toFloat().div(255).expandDims(0);
    return model.predict(pixels);
  });
  try {
    const learned = await result.data();
    if (learned.length !== SEMANTIC_SIZE || !learned.every(Number.isFinite) || !learned.some(v => v !== 0)) {
      throw new Error('Model returned an invalid embedding');
    }
    return { learned: normalized(learned), backend: tf.getBackend() };
  } finally {
    result.dispose();
  }
}
