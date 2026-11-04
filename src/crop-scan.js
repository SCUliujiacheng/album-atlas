export const MAX_CROP_PHOTOS = 300;

const aborted = () => new DOMException('Crop search was cancelled.', 'AbortError');
const unsupported = () =>
  new DOMException('Background crop search is unavailable in this browser.', 'NotSupportedError');

/** Each invocation owns one disposable worker. It receives file IDs, immutable
 * Blobs and the fingerprints already computed during duplicate review. */
export async function scanCrops(photos, { signal, onProgress } = {}) {
  if (signal?.aborted) throw aborted();
  if (!Array.isArray(photos)) throw new TypeError('A list of photos is required.');
  if (photos.length > MAX_CROP_PHOTOS) throw new RangeError('Crop search is limited to 300 photos.');
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') throw unsupported();
  const ids = new Set();
  const input = photos.map(({ id, blob, thumb, fingerprint }) => {
    if (typeof id !== 'string' || !id || ids.has(id))
      throw new TypeError('Photo IDs must be unique nonempty strings.');
    ids.add(id);
    const source = blob || thumb;
    if (!(source instanceof Blob)) throw new TypeError('A local photo Blob is required.');
    // Blob structured cloning shares immutable data. The worker decodes one source at a time.
    return { id, blob: source, fingerprint };
  });
  if (input.length < 2)
    return { pairs: [], truncated: false, examinedPairs: 0, totalPairs: 0, atLeast: 0 };
  let worker;
  try {
    worker = new Worker(new URL('./crop-worker.js', import.meta.url), {
      type: 'module',
      name: 'Album Atlas crop search',
    });
  } catch {
    throw unsupported();
  }
  return new Promise((resolve, reject) => {
    let active = true;
    let watchdog;
    function finish(handler, value) {
      if (!active) return;
      active = false;
      clearTimeout(watchdog);
      signal?.removeEventListener('abort', cancel);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      handler(value);
    }
    function cancel() {
      finish(reject, aborted());
    }
    function watch() {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => finish(reject, new Error('Crop-search worker stopped responding.')),
        120_000,
      );
    }
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      return;
    }
    worker.onerror = (event) => {
      event.preventDefault();
      finish(reject, new Error(event.message || 'Crop-search worker could not run.'));
    };
    worker.onmessageerror = () =>
      finish(reject, new Error('Unreadable message from crop-search worker.'));
    worker.onmessage = ({ data }) => {
      if (!active) return;
      if (data.type === 'progress') {
        watch();
        try {
          onProgress?.(data.progress);
        } catch (error) {
          finish(reject, error);
        }
      } else if (data.type === 'result') {
        finish(resolve, data.result);
      } else {
        const error =
          data.name === 'NotSupportedError'
            ? unsupported()
            : new Error(data.message || 'Crop search failed.');
        finish(reject, error);
      }
    };
    watch();
    try {
      worker.postMessage(input);
    } catch (error) {
      finish(reject, error);
    }
  });
}
