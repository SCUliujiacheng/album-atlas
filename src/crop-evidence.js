import { encodeCrop, possibleCrop } from './crop-matcher.js';
import { imageSignature, matchSignatures, sha256 } from './duplicates.js';
import { MAX_CROP_PHOTOS } from './crop-scan.js';

function pixels(bitmap, size) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new DOMException('A worker 2D canvas is unavailable.', 'NotSupportedError');
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size, size);
  context.drawImage(bitmap, 0, 0, size, size);
  return context.getImageData(0, 0, size, size).data;
}

// Decode one immutable Blob at a time. Imported previews have already undergone a
// lossy JPEG transcode, so use the original for the worker image whenever available.
export async function encodeCropPhoto(photo) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new DOMException(
      'This browser cannot decode and inspect images in a worker.',
      'NotSupportedError',
    );
  }
  const source = photo.blob || photo.thumb;
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  try {
    const aspect = bitmap.width / bitmap.height;
    const digest = photo.fingerprint?.digest || (await sha256(source));
    if (!digest) throw new DOMException('Secure local hashing is unavailable.', 'NotSupportedError');
    const signature = photo.fingerprint?.signature || imageSignature(pixels(bitmap, 32), 32, 32, aspect);
    return {
      id: photo.id,
      fingerprint: { digest, signature },
      crop: encodeCrop(pixels(bitmap, 64), aspect),
    };
  } finally {
    bitmap.close();
  }
}

// A returned pair always has its own geometric evidence. Matching A–B and B–C
// never implies A–C, and existing byte/whole-frame matches stay in Duplicate review.
export function compareCropPair(left, right) {
  const a = left.fingerprint,
    b = right.fingerprint;
  if ((a.digest && a.digest === b.digest) || matchSignatures(a.signature, b.signature)) return null;
  const hit = possibleCrop(left.crop, right.crop);
  if (!hit) return null;
  const [x, y, w, h] = hit.box;
  const [original, crop] = hit.container === 'left' ? [left, right] : [right, left];
  return {
    originalId: original.id,
    cropId: crop.id,
    box: { x, y, w, h },
    correlation: hit.correlation,
    colorDifference: hit.colorDifference,
  };
}

const MAX_PAIRS = 60;

export function scanCropPairs(records, onProgress = () => {}) {
  if (records.length > MAX_CROP_PHOTOS) throw new RangeError('Crop search is limited to 300 photos.');
  const totalPairs = (records.length * (records.length - 1)) / 2 || 0;
  const pairs = [];
  let examinedPairs = 0;
  onProgress(0, totalPairs);
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const hit = compareCropPair(records[i], records[j]);
      examinedPairs++;
      if (hit) {
        if (pairs.length === MAX_PAIRS) {
          onProgress(examinedPairs, totalPairs);
          return { pairs, examinedPairs, totalPairs, atLeast: MAX_PAIRS + 1, truncated: true };
        }
        pairs.push(hit);
      }
      if (examinedPairs % 32 === 0) onProgress(examinedPairs, totalPairs);
    }
  }
  onProgress(examinedPairs, totalPairs);
  return { pairs, examinedPairs, totalPairs, atLeast: pairs.length, truncated: false };
}
