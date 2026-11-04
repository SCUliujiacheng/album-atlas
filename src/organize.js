const pad = n => String(n).padStart(2, '0');

export function localDay(date) {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
}

function makeGroups(photos, getLabel) {
  const groups = new Map();
  for (const photo of photos) {
    const [id, name, nameEn = name] = getLabel(photo);
    if (!groups.has(id)) groups.set(id, { id, name, nameEn, photoIds: [] });
    groups.get(id).photoIds.push(photo.id);
  }
  return [...groups.values()];
}

export function dateGroups(photos) {
  const dated = photos.filter(p => p.date instanceof Date && Number.isFinite(p.date.getTime()));
  if (!dated.length) return [];
  const days = new Set(dated.map(p => localDay(p.date)));
  const months = new Set([...days].map(day => day.slice(0, 7)));
  const byMonth = days.size > 12 && months.size > 1;
  const datedIds = new Set(dated.map(p => p.id));
  if (days.size === 1) {
    let previous = null;
    let label;
    const sessions = new Map();
    for (const p of [...dated].sort((a, b) => a.date - b.date)) {
      if (!previous || p.date - previous > 90 * 60_000) {
        label = localDay(p.date) + ' ' + pad(p.date.getHours()) + '-' + pad(p.date.getMinutes());
      }
      sessions.set(p.id, label);
      previous = p.date;
    }
    return makeGroups(photos, p => sessions.has(p.id)
      ? ['event-' + sessions.get(p.id), sessions.get(p.id)]
      : ['undated', '日期未知', 'Unknown date']);
  }
  return makeGroups(photos, p => {
    if (!datedIds.has(p.id)) return ['undated', '日期未知', 'Unknown date'];
    const label = byMonth ? localDay(p.date).slice(0, 7) : localDay(p.date);
    return ['date-' + label, label];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

const tones = [
  ['red', '绯红与暖橙', 'Reds & oranges'], ['gold', '金黄与琥珀', 'Gold & amber'],
  ['green', '草木绿', 'Foliage greens'], ['aqua', '薄荷与青碧', 'Mint & teal'],
  ['blue', '海蓝与靛青', 'Blue & indigo'], ['pink', '紫罗兰与玫红', 'Violet & rose']
];

// Vote with pixels rather than averaging RGB: blue sky and orange sand do
// not form a grey subject. Weight saturation, while preserving neutral scenes.
export function toneFromPixels(rgba) {
  const votes = Array(6).fill(0);
  let luminance = 0, weight = 0, count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    luminance += 0.21 * r + 0.72 * g + 0.07 * b;
    count++;
    if (delta < 0.09 || max < 0.11) continue;
    let hue = max === r ? (g-b)/delta : max === g ? 2+(b-r)/delta : 4+(r-g)/delta;
    hue = (hue * 60 + 360) % 360;
    const bin = hue < 32 || hue >= 345 ? 0 : hue < 69 ? 1 : hue < 157 ? 2 : hue < 194 ? 3 : hue < 263 ? 4 : 5;
    votes[bin] += delta;
    weight += delta;
  }
  if (!count || weight / count < 0.065) {
    return luminance / Math.max(1, count) < 0.42
      ? ['ink', '深色与炭灰', 'Charcoal tones'] : ['silver', '银灰与浅色', 'Silver & light'];
  }
  return tones[votes.indexOf(Math.max(...votes))];
}

export function paletteGroups(photos) {
  return makeGroups(photos, p => p.palette);
}

export function shapeGroups(photos) {
  return makeGroups(photos, p => {
    const ratio = p.width / p.height;
    if (ratio < 0.85) return ['portrait', '竖幅', 'Portrait'];
    if (ratio > 1.18) return ['landscape', '横幅', 'Landscape'];
    return ['square', '近方形', 'Nearly square'];
  });
}
