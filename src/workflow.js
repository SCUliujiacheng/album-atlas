import { parse } from '../vendor/exifr.mjs';
import { extractEmbedding } from './embedding.js';
import { classify, cluster } from './ml.js';
import { fingerprint } from './duplicates.js';
import { dateGroups, paletteGroups, shapeGroups, toneFromPixels } from './organize.js';
export { exportAlbums } from './archive.js';

const maxFileBytes = 32 * 1024 * 1024;
const maxBatchBytes = 512 * 1024 * 1024;
const rasterExt = /\.(jpe?g|jfif|png|webp|avif|gif|bmp)$/i;
const rasterType = /^image\/(jpeg|png|webp|avif|gif|bmp|x-ms-bmp)$/i;
const id = () => globalThis.crypto?.randomUUID?.() ?? 'photo-' + Date.now() + '-' + Math.random().toString(36).slice(2);

function canvasOf(image, maxSize) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function readPhoto(file, checkCopies = false) {
  if (!rasterExt.test(file.name) && !rasterType.test(file.type)) throw new Error('不支持此格式 · Unsupported format');
  if (file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name)) throw new Error('不支持 SVG · Unsupported SVG');
  if (!file.size || file.size > maxFileBytes) throw new Error('文件为空或超过 32 MiB · Empty or over 32 MiB');
  const original = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = original;
    try { await image.decode(); } catch { throw new Error('无法解码图片 · Image could not be decoded'); }
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width * height > 90_000_000) throw new Error('图片尺寸超出范围 · Image too large');
    const preview = canvasOf(image, 560);
    const tiny = canvasOf(image, 36);
    const palette = toneFromPixels(tiny.getContext('2d').getImageData(0, 0, tiny.width, tiny.height).data);
    const { vector, kind } = await extractEmbedding(preview);
    const thumb = await new Promise(resolve => preview.toBlob(resolve, 'image/jpeg', 0.82));
    const meta = await parse(file, ['DateTimeOriginal']).catch(() => undefined);
    let date = meta?.DateTimeOriginal;
    let dateSource = 'exif';
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      date = Number.isFinite(file.lastModified) && file.lastModified > 0 ? new Date(file.lastModified) : null;
      dateSource = date ? 'modified' : null;
    }
    return { id:id(), name:file.name, blob:file, url:URL.createObjectURL(thumb || file), thumb:thumb || file,
      width, height, date, dateSource, palette, vector, kind,
      fingerprint:checkCopies ? await fingerprint(file,image) : undefined };
  } finally {
    URL.revokeObjectURL(original);
  }
}

export async function ingest(files, onProgress = () => {}, checkCopies = true) {
  const list = Array.from(files);
  const photos = [], errors = [];
  if (list.length > 300 || list.reduce((sum, file) => sum + file.size, 0) > maxBatchBytes) {
    return { photos, errors: ['每批最多 300 张、512 MiB · At most 300 files and 512 MiB per batch'] };
  }
  for (const [index, file] of list.entries()) {
    try { photos.push(await readPhoto(file,checkCopies)); }
    catch (e) { errors.push(file.name + ' — ' + (e.message || 'Unreadable image')); }
    onProgress(index + 1, list.length, file.name);
    if ((index + 1) % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { photos, errors };
}

const sampleAlbums = [
  ['shore', '海岸', 'Coast'], ['forest', '森林', 'Forest'], ['city', '城市', 'City']
];

export async function loadDemo(onProgress = () => {}) {
  const albums = [], photos = [], loaded = [];
  try {
    for (const [albumIndex, [key, name, nameEn]] of sampleAlbums.entries()) {
      const album = {id:key, name, nameEn, photos:[]};
      albums.push(album);
      for (let n = 1; n <= 4; n++) {
        const filename = key + '-0' + n + '.jpg';
        const url = new URL('../assets/demo/' + filename, import.meta.url);
        const response = await fetch(url);
        if (!response.ok) throw new Error('Demo photo unavailable: ' + filename);
        const blob = await response.blob();
        const photo = await readPhoto(new File([blob], filename, {type:'image/jpeg'}), n > 2);
        loaded.push(photo);
        // Illustrative dates create a time-based alternative in the sample set.
        photo.date = new Date(2025, 3, 5 + (n + albumIndex) % 3, 9 + albumIndex, n);
        photo.dateSource = 'demo';
        if (n <= 2) album.photos.push(photo);
        else photos.push(photo);
        onProgress(loaded.length, 12, filename);
      }
    }
    return {albums, photos};
  } catch (e) {
    loaded.forEach(p => URL.revokeObjectURL(p.url));
    throw e;
  }
}

export async function organizeKnown(photos, albums) {
  const trained = albums.filter(a => a.photos.length).map(a => ({id:a.id, vectors:a.photos.map(p => p.vector)}));
  const groups = albums.map(a => ({id:a.id, name:a.name, nameEn:a.nameEn, photoIds:[]}));
  const map = new Map(groups.map(g => [g.id, g]));
  const predictions = Object.create(null), uncertainIds = [];
  for (const photo of photos) {
    const result = classify(photo.vector, trained);
    predictions[photo.id] = result;
    if (result.albumId && map.has(result.albumId)) map.get(result.albumId).photoIds.push(photo.id);
    else uncertainIds.push(photo.id);
  }
  return {groups, uncertainIds, predictions};
}

export async function proposePlans(photos) {
  if (!photos.length) return [];
  const k = Math.min(8, photos.length, Math.max(2, Math.round(Math.sqrt(photos.length))));
  const labels = cluster(photos.map(p => p.vector), k);
  const visual = new Map();
  labels.forEach((label, i) => {
    if (!visual.has(label)) {
      const number = String(visual.size + 1).padStart(2, '0');
      visual.set(label, {id:'visual-' + number, name:'视觉组 ' + number, nameEn:'Visual group ' + number, photoIds:[]});
    }
    visual.get(label).photoIds.push(photos[i].id);
  });
  const modified = photos.some(p => p.dateSource === 'modified');
  const demo = photos.some(p => p.dateSource === 'demo');
  const plans = [
    {id:'visual',name:'按画面相似度',nameEn:'Visual similarity',description:'把构图与内容接近的照片放在一起。',descriptionEn:'Gather photos with similar content and composition.',groups:[...visual.values()]},
    {id:'time',name:'按日期与行程',nameEn:'Dates & outings',description:demo?'样片使用演示日期。':modified?'优先使用拍摄时间；缺失时使用文件修改时间。':'按拍摄时间分组，同一天可按相隔 90 分钟的时段拆分。',descriptionEn:demo?'Examples use illustrative dates.':modified?'Uses capture dates when available, otherwise file modification dates.':'Uses capture dates, with 90-minute gaps separating same-day sessions.',groups:dateGroups(photos)},
    {id:'palette',name:'按主色调',nameEn:'Color palette',description:'适合拼贴、摄影集与配色选片。',descriptionEn:'Build a contact sheet around the dominant color of each photo.',groups:paletteGroups(photos)},
    {id:'shape',name:'按画幅',nameEn:'Image orientation',description:'分开横幅、竖幅与近方形，方便排版。',descriptionEn:'Separate landscape, portrait and nearly square frames for layout.',groups:shapeGroups(photos)}
  ];
  return plans.filter(p => p.id === 'visual' || p.id === 'palette' || p.groups.length > 1);
}
