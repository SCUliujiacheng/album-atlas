import { runModel } from './model-runtime.js';

let queued = Promise.resolve();
self.onmessage = ({ data: { id, rgba, width, height } }) => {
  queued = queued.then(async () => {
    try {
      const frame = new ImageData(new Uint8ClampedArray(rgba), width, height);
      const result = await runModel(frame);
      self.postMessage({ id, ...result });
    } catch (error) {
      self.postMessage({ id, error: error?.message || String(error) });
    }
  });
};
