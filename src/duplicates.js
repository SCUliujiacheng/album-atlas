// Format 1. Flatten on white before sampling, as in the photo preview.
export function imageSignature(rgba, width, height, aspect = width / height) {
  const light = new Float64Array(256),
    colors = new Float64Array(32);
  const counts = new Uint32Array(256),
    blocks = new Uint32Array(16);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = 4 * (y * width + x),
        cell = Math.floor((16 * y) / height) * 16 + Math.floor((16 * x) / width);
      const block = Math.floor((4 * y) / height) * 4 + Math.floor((4 * x) / width);
      const r = rgba[pixel] / 255,
        g = rgba[pixel + 1] / 255,
        b = rgba[pixel + 2] / 255;
      light[cell] += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      colors[2 * block] += r - g;
      colors[2 * block + 1] += b - g;
      counts[cell]++;
      blocks[block]++;
    }
  for (let i = 0; i < light.length; i++) light[i] /= counts[i] || 1;
  for (let i = 0; i < colors.length; i++) colors[i] /= blocks[i >> 1] || 1;
  const mean = light.reduce((sum, x) => sum + x, 0) / light.length;
  const centered = light.map((x) => x - mean);
  const norm = Math.hypot(...centered);
  return { aspect, mean, contrast: norm / 16, structure: centered.map((x) => x / (norm || 1)), colors };
}

export function matchSignatures(a, b) {
  if (
    !a ||
    !b ||
    Math.abs(Math.log(a.aspect / b.aspect)) > 0.035 ||
    Math.min(a.contrast, b.contrast) < 0.035 ||
    Math.abs(a.mean - b.mean) > 0.18
  )
    return null;
  let colorDifference = 0;
  for (let i = 0; i < a.colors.length; i++) colorDifference += Math.abs(a.colors[i] - b.colors[i]);
  colorDifference /= a.colors.length;
  if (colorDifference > 0.075) return null;
  let correlation = 0;
  for (let i = 0; i < a.structure.length; i++) correlation += a.structure[i] * b.structure[i];
  if (correlation < 0.975) return null;
  return { correlation: Math.min(1, correlation), colorDifference };
}

export async function sha256(blob) {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}

export async function fingerprint(blob, image) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 32, 32);
  ctx.drawImage(image, 0, 0, 32, 32);
  const aspect = (image.naturalWidth || image.width) / (image.naturalHeight || image.height);
  return {
    digest: await sha256(blob),
    signature: imageSignature(ctx.getImageData(0, 0, 32, 32).data, 32, 32, aspect),
  };
}

export async function upgradePhotoFingerprints(photos) {
  for (const photo of photos) {
    if (photo.fingerprint) continue;
    const url = URL.createObjectURL(photo.blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      photo.fingerprint = await fingerprint(photo.blob, image);
    } catch {
      // Older drafts can still be restored if a browser no longer decodes their format.
      photo.fingerprint = { digest: await sha256(photo.blob), signature: null };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** An exact match points to the file whose bytes matched. Each visual match must
 * resemble its group anchor directly, preventing chains of weakly related photos. */
export function duplicateGroups(photos) {
  const groups = [],
    exact = new Map();
  for (const photo of photos) {
    if (!photo.fingerprint) continue;
    const { digest, signature } = photo.fingerprint;
    const same = digest && exact.get(digest);
    if (same) {
      same.group.push({ photo, kind: 'exact', withId: same.id });
      continue;
    }
    let selected, best;
    for (const group of groups) {
      const comparison = matchSignatures(signature, group[0].photo.fingerprint.signature);
      if (comparison && (!best || comparison.correlation > best.correlation)) {
        selected = group;
        best = comparison;
      }
    }
    if (!selected) {
      selected = [{ photo, kind: 'anchor', withId: null }];
      groups.push(selected);
    } else selected.push({ photo, kind: 'similar', withId: selected[0].photo.id, ...best });
    if (digest) exact.set(digest, { id: photo.id, group: selected });
  }
  return groups.filter((group) => group.length > 1);
}
