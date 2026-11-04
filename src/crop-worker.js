import { encodeCropPhoto, scanCropPairs } from './crop-evidence.js';
import { MAX_CROP_PHOTOS } from './crop-scan.js';

self.onmessage = async ({ data: photos }) => {
  const records = [];
  let previousPhase,
    previousCompleted,
    lastSent = -Infinity;
  function progress(phase, completed, total) {
    if (phase === previousPhase && completed === previousCompleted) return;
    const now = performance.now();
    if (phase !== previousPhase || completed === total || now - lastSent >= 100) {
      self.postMessage({ type: 'progress', progress: { phase, completed, total } });
      previousPhase = phase;
      previousCompleted = completed;
      lastSent = now;
    }
  }
  try {
    if (photos.length > MAX_CROP_PHOTOS) throw new RangeError('Crop search is limited to 300 photos.');
    progress('encoding', 0, photos.length);
    for (const photo of photos) {
      records.push(await encodeCropPhoto(photo));
      progress('encoding', records.length, photos.length);
    }
    const result = scanCropPairs(records, (done, total) => progress('comparing', done, total));
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      name: error.name,
      message: error.message || 'Crop search failed.',
    });
  } finally {
    records.length = 0;
    self.close();
  }
};
