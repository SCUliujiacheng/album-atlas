import { Zip, ZipPassThrough, strToU8 } from '../vendor/fflate.mjs';

function cleanName(value) {
  const cleaned = String(value ?? '').normalize('NFC')
    .replace(/[\\/<>:"|?*]/g, '_')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().replace(/[ .]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? '_' + cleaned : cleaned;
}

function uniqueName(value, used, preserveExtension = false) {
  const clean = cleanName(value);
  const dot = preserveExtension ? clean.lastIndexOf('.') : -1;
  const ext = dot > 0 ? clean.slice(dot, dot+20) : '';
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  // Keep comfortably inside common per-component filesystem byte limits.
  const shorten = (s, limit) => {
    let result = '', bytes = 0;
    for (const char of s) {
      bytes += new TextEncoder().encode(char).length;
      if (bytes > limit) break;
      result += char;
    }
    return result;
  };
  const stem = shorten(base, 160);
  let name = stem + ext, n = 2;
  while (used.has(name.toLowerCase())) name = stem + ' (' + n++ + ')' + ext;
  used.add(name.toLowerCase());
  return name;
}

export async function exportAlbums(photos, groups) {
  const byId = new Map(photos.map(p => [p.id, p]));
  const groupNames = new Set(['album-atlas.json']);
  const seen = new Set(), manifest = [], parts = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    parts.push(chunk);
  });
  for (const group of groups) {
    if (!group.photoIds.length) continue;
    const folder = uniqueName(group.name, groupNames);
    const fileNames = new Set();
    for (const id of group.photoIds) {
      const photo = byId.get(id);
      if (!photo || seen.has(id)) throw new Error('Invalid or repeated photo in export');
      seen.add(id);
      const path = folder + '/' + uniqueName(photo.name, fileNames, true);
      const entry = new ZipPassThrough(path);
      zip.add(entry);
      for await (const chunk of readBlob(photo.blob)) entry.push(chunk);
      entry.push(new Uint8Array(), true);
      manifest.push({ original: photo.name, path, bytes: photo.blob.size });
    }
  }
  if (!manifest.length) throw new Error('No photos to export');
  // A missed assignment must never silently drop an original from an export.
  if (seen.size !== byId.size) throw new Error('Some photos still need a destination');
  const index = new ZipPassThrough('album-atlas.json');
  zip.add(index);
  index.push(strToU8(JSON.stringify({ version: 1, photos: manifest }, null, 2)), true);
  zip.end();
  return new Blob(parts, {type: 'application/zip'});
}

async function* readBlob(blob) {
  // slice() also works on mobile browsers without async-iterable streams.
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    yield new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
  }
}
