// A local, partially overlapping image pair is represented by a rectangle in a
// common 64px coordinate system, regardless of its original pixel dimensions.
// Operating points were selected on a separate calibration set. See docs/crop-review.md.
const SIZE = 64;
const STRIDE = SIZE + 1;
const ASPECT_RATIOS = [0.75, 1, 4 / 3];
const WINDOW_SCALES = [0.58, 0.68, 0.78, 0.88];
const WINDOWS_PER_RATIO = WINDOW_SCALES.length * 25;
const MIN_CONTRAST = 0.035;
const WHOLE_FRAME = [0, 0, SIZE, SIZE];

function buildIntegralChannels(rgba) {
  const channels = Array.from({ length: 3 }, () => new Float32Array(STRIDE * STRIDE));
  for (let y = 1; y <= SIZE; y++) {
    let light = 0,
      redGreen = 0,
      blueGreen = 0;
    for (let x = 1; x <= SIZE; x++) {
      const pixel = 4 * ((y - 1) * SIZE + x - 1);
      const position = y * STRIDE + x;
      const red = rgba[pixel] / 255;
      const green = rgba[pixel + 1] / 255;
      const blue = rgba[pixel + 2] / 255;
      light += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      redGreen += red - green;
      blueGreen += blue - green;
      channels[0][position] = light + channels[0][position - STRIDE];
      channels[1][position] = redGreen + channels[1][position - STRIDE];
      channels[2][position] = blueGreen + channels[2][position - STRIDE];
    }
  }
  return channels;
}

// A summed-area table gives each cell's average from its four corners.
function sampleIntegerCells(channel, box, grid, output) {
  const [x, y, width, height] = box;
  for (let row = 0; row < grid; row++) {
    const top = y + Math.round((row * height) / grid);
    const bottom = y + Math.round(((row + 1) * height) / grid);
    for (let column = 0; column < grid; column++) {
      const left = x + Math.round((column * width) / grid);
      const right = x + Math.round(((column + 1) * width) / grid);
      const sum =
        channel[bottom * STRIDE + right] -
        channel[top * STRIDE + right] -
        channel[bottom * STRIDE + left] +
        channel[top * STRIDE + left];
      output[row * grid + column] = sum / ((right - left) * (bottom - top));
    }
  }
}

// Fractional registration uses bilinear interpolation at each cell corner. Two
// rolling rows retain the previous corners without allocating a whole lattice.
function sampleSubpixelCells(channel, box, grid, output, previous, current) {
  const [x, y, width, height] = box;
  const cellArea = (width * height) / (grid * grid);
  for (let row = 0; row <= grid; row++) {
    const sy = Math.min(SIZE, y + (row * height) / grid);
    const y0 = Math.floor(sy),
      y1 = Math.min(SIZE, y0 + 1),
      dy = sy - y0;
    for (let column = 0; column <= grid; column++) {
      const sx = Math.min(SIZE, x + (column * width) / grid);
      const x0 = Math.floor(sx),
        x1 = Math.min(SIZE, x0 + 1),
        dx = sx - x0;
      const a = channel[y0 * STRIDE + x0],
        b = channel[y0 * STRIDE + x1];
      const d = channel[y1 * STRIDE + x0],
        e = channel[y1 * STRIDE + x1];
      current[column] = (1 - dy) * (a + dx * (b - a)) + dy * (d + dx * (e - d));
      if (column && row) {
        const sum = current[column] - current[column - 1] - previous[column] + previous[column - 1];
        output[(row - 1) * grid + column - 1] = sum / cellArea;
      }
    }
    [previous, current] = [current, previous];
  }
}

function centeredStats(values) {
  let sum = 0,
    squaredSum = 0;
  for (const value of values) {
    sum += value;
    squaredSum += value * value;
  }
  const mean = sum / values.length;
  return { mean, norm: Math.sqrt(Math.max(0, squaredSum - sum * mean)) };
}

function writeLayoutSketch(values, vectors, offset, bits, bitOffset) {
  const { mean, norm } = centeredStats(values);
  let lowBits = 0,
    highBits = 0;
  for (let i = 0; i < 64; i++) {
    const centered = values[i] - mean;
    vectors[offset + i] = Math.round((120 * centered) / (norm || 1));
    if (centered <= 0) continue;
    if (i < 32) lowBits |= 1 << i;
    else highBits |= 1 << (i - 32);
  }
  bits[bitOffset] = lowBits;
  bits[bitOffset + 1] = highBits;
  return norm / 8;
}

function buildWindows() {
  const windows = [];
  for (const ratio of ASPECT_RATIOS) {
    for (const scale of WINDOW_SCALES) {
      const width = Math.round(SIZE * scale * Math.min(1, ratio));
      const height = Math.round(SIZE * scale * Math.min(1, 1 / ratio));
      for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
          windows.push([
            Math.round((x / 4) * (SIZE - width)),
            Math.round((y / 4) * (SIZE - height)),
            width,
            height,
          ]);
        }
      }
    }
  }
  return windows;
}
const windows = buildWindows();

// The layout bank for all possible containers and the whole-frame query share
// one encoding. All source image pixels may be released once this returns.
export function encodeCrop(rgba, aspect) {
  const channels = buildIntegralChannels(rgba);
  const bank = new Int8Array(windows.length * 64);
  const bits = new Int32Array(windows.length * 2);
  const valid = new Uint8Array(windows.length);
  const scratch = new Float32Array(64);
  for (let i = 0; i < windows.length; i++) {
    sampleIntegerCells(channels[0], windows[i], 8, scratch);
    valid[i] = writeLayoutSketch(scratch, bank, i * 64, bits, i * 2) >= MIN_CONTRAST;
  }
  const query = new Int8Array(64),
    qbits = new Int32Array(2);
  sampleIntegerCells(channels[0], WHOLE_FRAME, 8, scratch);
  writeLayoutSketch(scratch, query, 0, qbits, 0);

  const fine = new Float32Array(256),
    red = new Float32Array(16),
    blue = new Float32Array(16);
  sampleIntegerCells(channels[0], WHOLE_FRAME, 16, fine);
  sampleIntegerCells(channels[1], WHOLE_FRAME, 4, red);
  sampleIntegerCells(channels[2], WHOLE_FRAME, 4, blue);
  const { mean, norm } = centeredStats(fine);
  for (let i = 0; i < fine.length; i++) fine[i] = (fine[i] - mean) / (norm || 1);
  const detail = new Float32Array(48 * 48);
  sampleSubpixelCells(channels[0], WHOLE_FRAME, 48, detail, new Float64Array(49), new Float64Array(49));
  const bytes = [...channels, bank, bits, valid, query, qbits, fine, red, blue, detail].reduce(
    (sum, buffer) => sum + buffer.byteLength,
    0,
  );
  return {
    channels,
    bank,
    bits,
    valid,
    query,
    qbits,
    fine,
    red,
    blue,
    detail,
    mean,
    contrast: norm / 16,
    aspect,
    bytes,
  };
}

function popcount(value) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Reject incompatible shapes and layout hashes before running expensive registration.
function chooseWindow(source, target, ratio) {
  const closest = ASPECT_RATIOS.reduce(
    (best, candidate, i) =>
      Math.abs(Math.log(ratio / candidate)) < Math.abs(Math.log(ratio / ASPECT_RATIOS[best])) ? i : best,
    0,
  );
  if (Math.abs(Math.log(ratio / ASPECT_RATIOS[closest])) > 0.095) return null;
  let bestScore = 0.83,
    winner = null;
  for (let i = closest * WINDOWS_PER_RATIO; i < (closest + 1) * WINDOWS_PER_RATIO; i++) {
    if (!source.valid[i]) continue;
    const distance =
      popcount(source.bits[i * 2] ^ target.qbits[0]) + popcount(source.bits[i * 2 + 1] ^ target.qbits[1]);
    if (distance > 17) continue;
    let score = 0;
    for (let j = 0; j < 64; j++) score += target.query[j] * source.bank[i * 64 + j];
    score /= 14400;
    if (score > bestScore) {
      bestScore = score;
      winner = windows[i];
    }
  }
  return winner;
}

function scoreRegion(source, target, box, best, buffers, sample) {
  const { fine, red, blue, previous, current } = buffers;
  sample(source.channels[0], box, 16, fine, previous, current);
  const { mean, norm } = centeredStats(fine);
  if (norm / 16 < MIN_CONTRAST || Math.abs(mean - target.mean) > 0.12) return best;
  let dot = 0;
  for (let i = 0; i < 256; i++) dot += fine[i] * target.fine[i];
  const correlation = dot / norm;
  if (correlation < 0.88 || correlation <= (best?.correlation || 0)) return best;
  sample(source.channels[1], box, 4, red, previous, current);
  sample(source.channels[2], box, 4, blue, previous, current);
  let difference = 0;
  for (let i = 0; i < 16; i++)
    difference += Math.abs(red[i] - target.red[i]) + Math.abs(blue[i] - target.blue[i]);
  difference /= 32;
  return difference <= 0.065
    ? { correlation, colorDifference: difference, box: box.map((v) => v / SIZE) }
    : best;
}

// Keep the window center fixed during scale adjustment, then test neighboring
// translations in a stable order. Initial positions align to whole pixels.
function searchNeighborhood(source, target, ratio, origin, step, best, buffers, integerPixels) {
  const [x, y, width, height] = origin;
  const offsets = [-step, 0, step];
  const snap = integerPixels ? Math.round : (value) => value;
  const sample = integerPixels ? sampleIntegerCells : sampleSubpixelCells;
  for (const scale of offsets) {
    const w = width + snap(scale * Math.min(1, ratio));
    const h = height + snap(scale * Math.min(1 / ratio, 1));
    for (const dx of offsets) {
      for (const dy of offsets) {
        const left = Math.max(0, Math.min(SIZE - w, x + dx - snap((w - width) / 2)));
        const top = Math.max(0, Math.min(SIZE - h, y + dy - snap((h - height) / 2)));
        best = scoreRegion(source, target, [left, top, w, h], best, buffers, sample);
      }
    }
  }
  return best;
}

// A small edited area can disappear in an otherwise high whole-frame score.
// Measure brightness-adjusted absolute residuals in 64 local tiles.
function measureLocalChanges(source, target, result) {
  const warped = new Float32Array(48 * 48);
  sampleSubpixelCells(
    source.channels[0],
    result.box.map((v) => v * SIZE),
    48,
    warped,
    new Float64Array(49),
    new Float64Array(49),
  );
  const origin = centeredStats(warped),
    query = centeredStats(target.detail);
  const gain = query.norm / (origin.norm || 1);
  const residuals = new Float32Array(64);
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const i = y * 48 + x,
        tile = Math.floor(y / 6) * 8 + Math.floor(x / 6);
      residuals[tile] += Math.abs(target.detail[i] - (query.mean + gain * (warped[i] - origin.mean))) / 36;
    }
  }
  residuals.sort();
  result.maxPatch = residuals[63];
  result.medianPatch = (residuals[31] + residuals[32]) / 2;
  return result;
}

function registerCrop(source, target) {
  if (target.contrast < MIN_CONTRAST) return null;
  const ratio = target.aspect / source.aspect;
  const coarse = chooseWindow(source, target, ratio);
  if (!coarse) return null;
  const buffers = {
    fine: new Float32Array(256),
    red: new Float32Array(16),
    blue: new Float32Array(16),
    previous: new Float64Array(17),
    current: new Float64Array(17),
  };
  let best = searchNeighborhood(source, target, ratio, coarse, 2, null, buffers, true);
  if (!best) return null;
  for (const step of [1, 0.5]) {
    best = searchNeighborhood(
      source,
      target,
      ratio,
      best.box.map((v) => v * SIZE),
      step,
      best,
      buffers,
      false,
    );
  }
  return measureLocalChanges(source, target, best);
}

export function possibleCrop(left, right) {
  const forward = registerCrop(left, right);
  const reverse = registerCrop(right, left);
  const useReverse = reverse && (!forward || reverse.correlation > forward.correlation);
  const hit = useReverse ? reverse : forward;
  if (!hit || hit.correlation < 0.955 || hit.maxPatch > 0.03 + 1.5 * hit.medianPatch) return null;
  return { ...hit, container: useReverse ? 'right' : 'left', kind: 'possible-crop' };
}
