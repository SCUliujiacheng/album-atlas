import { loadDemo, ingest, organizeKnown, proposePlans, exportAlbums } from './workflow.js';
import { saveDraft, loadDraft, clearDraft, hasDraft } from './draft.js';

const byId = (id) => document.getElementById(id);
const desk = byId('desk');
const looseInput = byId('loose-input');
const folderInput = byId('folder-input');
const refInput = byId('reference-input');
const unassigned = '__atlas_review__';
const maxPhotos = 300;
const maxWorkspaceBytes = 512 * 1024 * 1024;
let language = 'zh';
try {
  if (localStorage.getItem('atlas-language') === 'en') language = 'en';
} catch {
  /* storage is optional */
}
const t = (cn, en) => (language === 'en' ? en : cn);
const fresh = () => ({
  mode: 'known',
  albums: [],
  photos: [],
  known: null,
  discover: null,
  plans: [],
  sample: false,
  dirty: false,
  busy: false,
  notice: null,
  errors: [],
});
let state = fresh();
let refName = '';
let previewOriginal = null;
let groupSequence = 0;
let storageState = 'checking';
let draftIsCurrent = false;
let unsavedReviews = new WeakSet();
const newGroupId = () => 'album-' + Date.now().toString(36) + '-' + ++groupSequence;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(
    ...children
      .flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false),
  );
  return node;
}
function button(label, fn, style = 'small-action', disabled = false) {
  return el(
    'button',
    { type: 'button', class: style, disabled: disabled || state.busy, onclick: fn },
    label,
  );
}
const count = (n) => t(n + ' 张', n + (n === 1 ? ' photo' : ' photos'));
const albumName = (a) => (language === 'en' && a.nameEn ? a.nameEn : a.name);
const photoMap = () => new Map(state.photos.map((p) => [p.id, p]));
function notice(cn, en) {
  state.notice = cn ? [cn, en] : null;
  byId('live').textContent = state.notice ? t(...state.notice) : '';
}
function scrollToArea(id) {
  const area = byId(id);
  if (!area) return;
  area.focus({ preventScroll: true });
  area.scrollIntoView({ block: 'start', behavior: 'instant' });
}
const changed = () => {
  draftIsCurrent = false;
  if (!state.sample) state.dirty = true;
};
const errText = (err) => err?.message || String(err);

function translate() {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  document.title = t('相册罗盘 · Album Atlas', 'Album Atlas · Local photo organizer');
  for (const node of document.querySelectorAll('[data-cn]'))
    node.textContent = t(node.dataset.cn, node.dataset.en);
  for (const node of document.querySelectorAll('[data-label-cn]'))
    node.setAttribute('aria-label', t(node.dataset.labelCn, node.dataset.labelEn));
  const lang = byId('language');
  lang.textContent = t('English', '简体中文');
  lang.lang = t('en', 'zh-CN');
  lang.setAttribute('aria-label', t('Switch to English', '切换为简体中文'));
}
function errorsView() {
  const box = byId('errors');
  box.replaceChildren();
  if (!state.errors.length) return;
  const details = el(
    'details',
    {},
    el('summary', {}, t('查看详情', 'View details') + ' (' + state.errors.length + ')'),
    el(
      'ul',
      {},
      state.errors.map((s) => el('li', {}, s)),
    ),
  );
  box.append(
    el(
      'p',
      {},
      t(
        '部分操作未完成。已成功读取的照片可以继续整理。',
        'Some items could not be processed. Successfully loaded photos remain available.',
      ),
    ),
    details,
  );
}
function filmstrip(photos, max = 7) {
  return el(
    'div',
    { class: 'filmstrip' },
    photos.slice(0, max).map((photo) => el('img', { src: photo.url, alt: '', loading: 'lazy' })),
    photos.length > max && el('span', { class: 'thumb-more' }, '+' + (photos.length - max)),
  );
}
function looseWell() {
  const box = el(
    'div',
    { class: 'well' },
    el(
      'div',
      { class: 'row' },
      el('h3', {}, t('待整理照片', 'Unsorted photos')),
      el('span', { class: 'meta' }, count(state.photos.length)),
    ),
    el(
      'p',
      {},
      t(
        '把照片拖到这里，或选择 JPEG、PNG、WebP 等图片。照片只在本机处理。',
        'Drop photos here or choose JPEG, PNG, WebP and other supported images. Processing stays on your device.',
      ),
    ),
    button(
      state.photos.length ? t('继续添加照片', 'Add more photos') : t('选择照片', 'Choose photos'),
      () => looseInput.click(),
    ),
    state.photos.length > 0 && filmstrip(state.photos),
  );
  box.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (!state.busy) box.classList.add('drag');
  });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (ev) => {
    ev.preventDefault();
    box.classList.remove('drag');
    if (!state.busy) addFiles([...ev.dataTransfer.files], 'loose');
  });
  return box;
}
function limitsView() {
  return el(
    'details',
    { class: 'format-note' },
    el('summary', {}, t('支持的格式与容量', 'Supported formats and limits')),
    el(
      'p',
      { class: 'note' },
      t(
        '支持 JPEG、PNG、WebP、GIF、BMP，以及浏览器能解码的 AVIF。HEIC 和相机 RAW 请先转成 JPEG。单张最多 32 MiB；待整理照片和参考照片合计最多 300 张、512 MiB。',
        'Supports JPEG, PNG, WebP, GIF, BMP and browser-decodable AVIF. Convert HEIC or camera RAW to JPEG first. Up to 32 MiB per photo, and 300 photos or 512 MiB in total, including references.',
      ),
    ),
  );
}
function refWell() {
  return el(
    'div',
    { class: 'well' },
    el(
      'div',
      { class: 'row' },
      el('h3', {}, t('参考相册', 'Reference albums')),
      el('span', { class: 'meta' }, t(state.albums.length + ' 本', state.albums.length + ' albums')),
    ),
    el(
      'p',
      {},
      t(
        '选择一个相册文件夹，或选择包含多个相册子文件夹的目录。也可以单独命名一组参考照片。',
        'Pick an album folder or a parent folder containing several albums. You can also name a set of reference photos.',
      ),
    ),
    el(
      'div',
      { class: 'actions' },
      button(t('导入相册文件夹', 'Import album folders'), () => folderInput.click()),
      button(t('新建参考相册', 'New reference album'), () => {
        byId('reference-name').value = '';
        byId('name-dialog').showModal();
        byId('reference-name').focus();
      }),
    ),
    state.albums.length > 0 &&
      el(
        'ul',
        { class: 'refs' },
        state.albums.map((a) =>
          el(
            'li',
            {},
            el(
              'span',
              { class: 'album-mark' },
              a.photos[0] && el('img', { src: a.photos[0].url, alt: '' }),
              albumName(a),
            ),
            el('span', { class: 'meta' }, count(a.photos.length)),
          ),
        ),
      ),
  );
}
function render() {
  const known = state.mode === 'known';
  const diskReady = storageState === 'saved' || storageState === 'empty';
  byId('draft-save').disabled =
    state.busy || !diskReady || state.sample || !(state.photos.length || state.albums.length);
  byId('draft-load').disabled = byId('draft-clear').disabled = state.busy || storageState !== 'saved';
  byId('draft-status').textContent =
    storageState === 'saved'
      ? t('此浏览器中有一份草稿。', 'One saved draft is available in this browser.')
      : storageState === 'unavailable'
        ? t('此浏览器目前无法使用本机存储。', 'Local draft storage is unavailable in this browser.')
        : storageState === 'checking'
          ? t('正在检查浏览器存储…', 'Checking local storage…')
          : t('尚无已保存的本机草稿。', 'No draft saved on this device.');
  byId('known').setAttribute('aria-pressed', String(known));
  byId('discover').setAttribute('aria-pressed', String(!known));
  byId('workspace').setAttribute('aria-busy', String(state.busy));
  for (const id of ['known', 'discover', 'choose', 'demo', 'reset']) byId(id).disabled = state.busy;
  byId('reset').hidden = !(state.photos.length || state.albums.length);
  byId('live').textContent = state.notice ? t(...state.notice) : '';
  errorsView();
  const ready = state.photos.length > 0 && (!known || state.albums.length > 0);
  const help = !state.photos.length
    ? t('先添加待整理照片，或使用上方示例。', 'Add some photos or try the demo above.')
    : known && !state.albums.length
      ? t('至少需要一个有参考照片的相册。', 'Add at least one album with reference photos.')
      : t(
          count(state.photos.length) + '待整理，原图保持原样。',
          count(state.photos.length) + ' ready. Originals stay untouched.',
        );
  const hasOutput = state[state.mode] || (!known && state.plans.length);
  desk.replaceChildren(
    el(
      'p',
      { class: 'description' },
      known
        ? t(
            '用已有相册的参考照片匹配新照片。相似度不足的照片会单独留给你确认。',
            'Match new photos to examples from your albums. Uncertain matches stay in a separate review queue.',
          )
        : t(
            '比较可用的分组方式，先看每一组里的照片，再挑一套适合自己的方案。',
            'Compare the available ways to group your photos. Preview the actual sets before choosing a plan.',
          ),
    ),
    el('div', { class: 'import-grid' + (known ? '' : ' single') }, looseWell(), known && refWell()),
    limitsView(),
    el(
      'div',
      { class: 'run-row' },
      el('p', { class: 'detail' }, help),
      button(
        known ? t('匹配参考相册', 'Match albums') : t('生成分组方案', 'Generate plans'),
        () => analyze(),
        'button ' + (hasOutput ? 'outline' : 'primary'),
        !ready,
      ),
    ),
  );
  if (
    [...state.photos, ...(known ? state.albums.flatMap((a) => a.photos) : [])].some(
      (p) => p.kind === 'visual',
    )
  ) {
    desk.append(
      el(
        'p',
        { class: 'note' },
        t(
          '部分照片已使用轻量视觉特征匹配。当前结果会参考颜色、明暗和构图。',
          'Some photos used lightweight visual matching based on color, brightness and composition.',
        ),
      ),
    );
  }
  if (!known && state.plans.length) desk.append(plansView());
  if (state[state.mode]) desk.append(reviewView(state[state.mode]));
}

function planLabel(plan) {
  const names = {
    visual: ['画面相似度', 'Visual similarity'],
    time: ['时间线', 'Timeline'],
    palette: ['主色调', 'Color palette'],
    shape: ['画面构图', 'Composition'],
  };
  return language === 'en' ? plan.nameEn || (names[plan.id] ? names[plan.id][1] : plan.name) : plan.name;
}
function planDescription(plan) {
  const copy = {
    visual: 'Groups photos by visual resemblance.',
    time: 'Groups by available photo dates.',
    palette: 'Groups by dominant colors.',
    shape: 'Groups by image layout.',
  };
  return language === 'en' ? plan.descriptionEn || copy[plan.id] || plan.description : plan.description;
}
function plansView() {
  const photos = photoMap();
  return el(
    'section',
    { class: 'result', id: 'plans', tabindex: '-1' },
    el('div', { class: 'result-head' }, el('h3', {}, t('选择分组方案', 'Choose a grouping plan'))),
    el(
      'p',
      { class: 'note' },
      t(
        '每种方案都使用同一批照片。选中后仍可重命名相册或移动照片。',
        'Each plan uses the same collection. You can rename albums or move photos after choosing.',
      ),
    ),
    el(
      'div',
      { class: 'plans' },
      state.plans.map((plan) => {
        const selected = state.discover?.planId === plan.id;
        const card = el(
          'button',
          {
            type: 'button',
            class: 'plan' + (selected ? ' selected' : ''),
            disabled: state.busy,
            'aria-pressed': String(selected),
            onclick: () => pickPlan(plan),
          },
          el('h4', {}, planLabel(plan)),
          el('p', {}, planDescription(plan)),
        );
        function preview(group) {
          const valid = group.photoIds.map((id) => photos.get(id)).filter(Boolean);
          return el(
            'div',
            { class: 'mini-group' },
            valid.slice(0, 3).map((p) => el('img', { src: p.url, alt: p.name, loading: 'lazy' })),
            el('span', {}, albumName(group) + ' · ' + valid.length),
          );
        }
        const shown = 4;
        card.append(...plan.groups.slice(0, shown).map(preview));
        card.append(
          el(
            'span',
            { class: 'plan-foot' },
            selected ? t('已选方案 ✓', 'Selected ✓') : t('采用这套分组 →', 'Use this plan →'),
          ),
        );
        if (plan.groups.length <= shown) return card;
        const remaining = plan.groups.length - shown;
        const list = el('div', { class: 'more-groups-list', tabindex: '0' });
        const extra = el(
          'details',
          { class: 'more-groups' },
          el('summary', {}, t('查看其余 ' + remaining + ' 组', 'Preview ' + remaining + ' more groups')),
          list,
        );
        extra.addEventListener('toggle', () => {
          if (extra.open && !list.childElementCount)
            list.append(...plan.groups.slice(shown).map(preview));
        });
        return el('div', { class: 'plan-stack' }, card, extra);
      }),
    ),
  );
}
function copyGroups(groups) {
  return groups.map((g) => ({ ...g, photoIds: [...g.photoIds] }));
}
function rememberEdit(res) {
  unsavedReviews.add(res);
  res.undo = { groups: copyGroups(res.groups), uncertainIds: [...res.uncertainIds] };
}
function undoEdit(res) {
  if (!res.undo) return;
  unsavedReviews.add(res);
  res.groups = res.undo.groups;
  res.uncertainIds = res.undo.uncertainIds;
  res.undo = null;
  changed();
  notice('已撤销上一步调整。', 'Last adjustment undone.');
  render();
  scrollToArea('review');
}
function confirmEdited(result) {
  return (
    !result?.edited ||
    window.confirm(
      t(
        '这会替换此流程里手动调整过的分组。继续吗？',
        'This will replace your manual edits in this workflow. Continue?',
      ),
    )
  );
}
function pickPlan(plan) {
  if (state.discover?.planId === plan.id) {
    scrollToArea('review');
    return;
  }
  if (!confirmEdited(state.discover)) return;
  state.discover = { planId: plan.id, groups: copyGroups(plan.groups), uncertainIds: [], edited: false };
  changed();
  notice('方案已选定，可以调整相册。', 'Plan selected. You can now edit the albums.');
  render();
  scrollToArea('review');
}
function openPhoto(photo) {
  previewOriginal = URL.createObjectURL(photo.blob);
  byId('full-photo').src = previewOriginal;
  byId('full-photo').alt = photo.name;
  byId('full-name').textContent = photo.name;
  const details = [];
  if (photo.width && photo.height) details.push(photo.width + ' × ' + photo.height + ' px');
  if (photo.date instanceof Date) {
    const source = {
      exif: t('拍摄时间', 'Captured'),
      modified: t('文件修改时间', 'File modified'),
      demo: t('示例日期', 'Illustrative date'),
    };
    details.push(
      (source[photo.dateSource] || t('日期', 'Date')) +
        ' · ' +
        photo.date.toLocaleString(language === 'en' ? 'en' : 'zh-CN', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }),
    );
  }
  const match = state.mode === 'known' && state.known?.predictions?.[photo.id];
  const ref = match && state.albums.find((a) => a.id === match.suggestionId);
  if (ref && Number.isFinite(match.score))
    details.push(
      t('最相近参考相册', 'Closest reference album') +
        ' · ' +
        albumName(ref) +
        ' · ' +
        t('相似度', 'Similarity score') +
        ' ' +
        match.score.toFixed(2),
    );
  byId('full-meta').replaceChildren(...details.map((line) => el('div', {}, line)));
  byId('photo-dialog').showModal();
}
function movePhoto(id, target) {
  const res = state[state.mode];
  rememberEdit(res);
  for (const g of res.groups) g.photoIds = g.photoIds.filter((p) => p !== id);
  res.uncertainIds = res.uncertainIds.filter((p) => p !== id);
  if (target === unassigned) res.uncertainIds.push(id);
  else res.groups.find((g) => g.id === target).photoIds.push(id);
  res.edited = true;
  changed();
  notice('已移动照片。', 'Photo moved.');
  render();
  [...desk.querySelectorAll('[data-photo-select]')]
    .find((node) => node.dataset.photoSelect === id)
    ?.focus({ preventScroll: true });
}
function photoCard(photo, groupId, res) {
  const waiting = { id: unassigned, name: t('待确认', 'Needs review') };
  const option = (g) => el('option', { value: g.id, selected: g.id === groupId }, albumName(g));
  const allOptions = () => [...res.groups, waiting].map(option);
  const lazy = res.groups.length > 30;
  const current = groupId === unassigned ? waiting : res.groups.find((g) => g.id === groupId);
  const select = el(
    'select',
    {
      'aria-label': t('移动照片 ', 'Move photo ') + photo.name,
      'data-photo-select': photo.id,
      disabled: state.busy,
      onchange: (ev) => movePhoto(photo.id, ev.target.value),
    },
    lazy ? option(current) : allOptions(),
  );
  if (lazy) {
    // Only the active native picker needs the full list when hundreds of albums are open.
    const expand = () => {
      if (select.options.length === 1) select.replaceChildren(...allOptions());
    };
    select.addEventListener('focus', expand);
    select.addEventListener('pointerdown', expand);
    select.addEventListener('blur', () => select.replaceChildren(option(current)));
  }
  const prediction = res.predictions?.[photo.id];
  const suggested =
    groupId === unassigned && prediction && res.groups.find((g) => g.id === prediction.suggestionId);
  return el(
    'div',
    { class: 'photo-card' },
    el(
      'button',
      {
        type: 'button',
        class: 'photo-preview',
        'aria-label': t('预览 ', 'Preview ') + photo.name,
        onclick: () => openPhoto(photo),
      },
      el('img', { src: photo.url, alt: '', loading: 'lazy' }),
      el('span', { class: 'photo-name', title: photo.name }, photo.name),
    ),
    suggested && el('p', { class: 'hint' }, t('候选相册 · ', 'Closest album · ') + albumName(suggested)),
    suggested &&
      button(
        t('采用推荐去向', 'Accept suggestion'),
        () => movePhoto(photo.id, suggested.id),
        'small-action accept-suggestion',
      ),
    select,
  );
}
function albumSection(g, photos, res, review = false) {
  const title = review
    ? el('h4', { class: 'group-title' }, t('待确认', 'Needs review'))
    : el('input', {
        class: 'edit-name',
        type: 'text',
        value: albumName(g),
        maxlength: 80,
        disabled: state.busy,
        'aria-label': t('相册名称 · ', 'Album name · ') + albumName(g),
        onchange: (ev) => {
          const name = ev.target.value.trim();
          if (!name) {
            ev.target.value = albumName(g);
            return;
          }
          if (name === albumName(g)) return;
          rememberEdit(res);
          g.name = name;
          delete g.nameEn;
          res.edited = true;
          changed();
          ev.target.setAttribute('aria-label', t('相册名称 · ', 'Album name · ') + name);
          for (const option of desk.querySelectorAll('.photo-card option'))
            if (option.value === g.id) option.textContent = name;
          byId('undo').disabled = false;
        },
      });
  return el(
    'section',
    { class: 'group' + (review ? ' uncertain' : '') },
    el(
      'div',
      { class: 'group-head' },
      title,
      el('span', { class: 'meta' }, count(g.photoIds.length)),
      review &&
        button(t('保留为独立相册', 'Keep as a separate album'), () => {
          rememberEdit(res);
          res.groups.push({
            id: newGroupId(),
            name: '待整理',
            nameEn: 'Unfiled',
            photoIds: [...res.uncertainIds],
          });
          res.uncertainIds = [];
          res.edited = true;
          changed();
          render();
          scrollToArea('review');
        }),
    ),
    review &&
      el(
        'p',
        { class: 'note' },
        t(
          '逐张选择目的相册，或将这一组原样保留。',
          'Choose an album for each photo, or keep this set together.',
        ),
      ),
    g.photoIds.length
      ? el(
          'div',
          { class: 'group-grid' },
          g.photoIds.map((id) => photos.has(id) && photoCard(photos.get(id), g.id, res)),
        )
      : el(
          'p',
          { class: 'empty' },
          t('这个相册目前没有分配到照片。', 'No photos assigned to this album yet.'),
        ),
  );
}
function reviewView(res) {
  const photos = photoMap();
  const undo = button(t('撤销上一步', 'Undo last edit'), () => undoEdit(res), 'small-action', !res.undo);
  undo.id = 'undo';
  return el(
    'section',
    { class: 'result', id: 'review', tabindex: '-1' },
    el(
      'div',
      { class: 'result-head' },
      el('h3', {}, t('复核与导出', 'Review & export')),
      el(
        'div',
        { class: 'actions' },
        button(t('添加目的相册', 'Add a destination album'), () => {
          byId('group-name').value = '';
          byId('group-dialog').showModal();
          byId('group-name').focus();
        }),
        undo,
      ),
    ),
    el(
      'p',
      { class: 'note' },
      t(
        '点击照片可放大预览，点击相册名可改名。用照片下方的菜单调整归属。',
        'Click a photo to inspect it, edit an album name in place, or move a photo using its menu.',
      ),
    ),
    el(
      'div',
      { class: 'groups' },
      res.uncertainIds.length > 0 &&
        albumSection({ id: unassigned, photoIds: res.uncertainIds }, photos, res, true),
      res.groups.map((g) => albumSection(g, photos, res)),
    ),
    el(
      'div',
      { class: 'export-bar' },
      el(
        'p',
        { class: 'note' },
        res.uncertainIds.length
          ? t(
              '导出前请先处理 ' + res.uncertainIds.length + ' 张待确认照片。',
              'Review ' + res.uncertainIds.length + ' remaining photos before export.',
            )
          : t(
              'ZIP 包含本次待整理照片的原始文件副本，按相册存放。参考照片不会重复打包。',
              'The ZIP contains copies of the original unsorted files, filed by album. Reference photos are excluded.',
            ),
      ),
      button(
        t('导出 ZIP', 'Download ZIP'),
        () => download(res),
        'button primary',
        res.uncertainIds.length > 0 || !res.groups.some((g) => g.photoIds.length),
      ),
    ),
  );
}

function releaseWorkspace() {
  const urls = new Set([...state.photos, ...state.albums.flatMap((a) => a.photos)].map((p) => p.url));
  for (const url of urls) if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}
async function working(cn, en, fn) {
  if (state.busy) return false;
  state.busy = true;
  state.errors = [];
  notice(cn, en);
  render();
  try {
    await fn();
    return true;
  } catch (err) {
    state.errors.push(errText(err));
    notice('操作未完成，请查看详情或重试。', 'Could not finish. See details or try again.');
    return false;
  } finally {
    state.busy = false;
    render();
  }
}
function clearResults(mode) {
  state.known = null;
  if (mode === 'loose') {
    state.discover = null;
    state.plans = [];
  }
}
function willReplace(mode) {
  if (state.known?.edited || (mode === 'loose' && state.discover?.edited)) {
    return window.confirm(
      t(
        '添加照片会重新计算分组，本次手动调整将被替换。继续吗？',
        'Adding photos requires fresh groups and replaces current manual edits. Continue?',
      ),
    );
  }
  return true;
}
function referenceFolders(files, fallbackName) {
  const groups = new Map();
  for (const file of files) {
    const parts = (file.webkitRelativePath || '').split('/').filter(Boolean);
    const name =
      fallbackName ||
      (parts.length > 2 ? parts.slice(1, -1).join(' / ') : parts[0]) ||
      t('参考相册', 'Reference album');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(file);
  }
  return groups;
}
async function addFiles(files, kind, name = '') {
  if (!files.length || state.busy || !willReplace(kind)) return;
  let added = 0;
  const demoBefore = state.sample;
  if (
    demoBefore &&
    !window.confirm(
      t(
        '将退出示例并建立自己的工作台。继续吗？',
        'Leave the demo and start a workspace with your own photos?',
      ),
    )
  )
    return;
  const existing = demoBefore
    ? []
    : [...state.photos, ...state.albums.flatMap((a) => a.photos)].map((p) => p.blob);
  if (!withinCapacity([...existing, ...files])) {
    state.errors = [
      t(
        '本次选择将超过总量限制。请减少选择，或先导出并清空工作台。',
        'This selection would exceed the workspace limit. Select fewer files, or export and clear the desk first.',
      ),
    ];
    notice('每个工作台最多 300 张、512 MiB。', 'Each workspace supports up to 300 photos and 512 MiB.');
    render();
    scrollToArea('workspace');
    return;
  }
  const ok = await working('正在本地读取照片…', 'Reading photos on this device…', async () => {
    const imports = [];
    let offset = 0;
    const batches = kind === 'loose' ? new Map([['', files]]) : referenceFolders(files, name);
    for (const [label, batch] of batches) {
      const { photos, errors } = await ingest(batch, (done, total, filename) => {
        const progress = offset + done + '/' + files.length;
        notice(
          '读取 ' + progress + ' · ' + (filename || ''),
          'Reading ' + progress + ' · ' + (filename || ''),
        );
      });
      state.errors.push(...errors.map(errText));
      offset += batch.length;
      if (photos.length) {
        added += photos.length;
        imports.push({ label, photos });
      }
    }
    if (added) {
      if (demoBefore) {
        releaseWorkspace();
        state.albums = [];
        state.photos = [];
        state.sample = false;
        state.discover = null;
        state.plans = [];
      }
      clearResults(kind);
      for (const batch of imports) {
        if (kind === 'loose') state.photos.push(...batch.photos);
        else {
          const existing = state.albums.find((a) => a.name === batch.label);
          if (existing) existing.photos.push(...batch.photos);
          else state.albums.push({ id: newGroupId(), name: batch.label, photos: batch.photos });
        }
      }
      changed();
    }
    notice(
      added ? '已读取 ' + added + ' 张照片。' : '没有可用照片，请选择浏览器支持的图片。',
      added
        ? 'Loaded ' + added + (added === 1 ? ' photo.' : ' photos.')
        : 'No photos could be read. Choose images supported by your browser.',
    );
  });
  if (ok) scrollToArea('workspace');
}
function withinCapacity(blobs) {
  return (
    blobs.length <= maxPhotos &&
    blobs.reduce((sum, blob) => sum + (blob?.size || 0), 0) <= maxWorkspaceBytes
  );
}
async function runModel() {
  if (state.mode === 'known') {
    const matched = await organizeKnown(state.photos, state.albums);
    state.known = {
      ...matched,
      groups: copyGroups(matched.groups),
      uncertainIds: [...matched.uncertainIds],
      edited: false,
    };
    notice('相册匹配完成。请复核照片归属。', 'Album matching is complete. Review the assignments.');
  } else {
    const plans = await proposePlans(state.photos);
    if (!plans.length)
      throw new Error(
        t('没有可用方案。请添加更多照片后重试。', 'No plans available. Add more photos and try again.'),
      );
    state.plans = plans;
    state.discover = null;
    notice(
      '分组方案已生成。请选择一套进行复核。',
      'Your grouping plans are ready. Choose one to review.',
    );
  }
  changed();
}
async function analyze() {
  if (!confirmEdited(state[state.mode])) return;
  const ok = await working('正在分析照片…', 'Analyzing photos…', runModel);
  if (ok) scrollToArea(state.mode === 'known' ? 'review' : 'plans');
}
async function tryDemo() {
  if (
    (state.photos.length || state.albums.length) &&
    !window.confirm(t('用示例照片替换当前工作台？', 'Replace this workspace with the demo photos?'))
  )
    return;
  scrollToArea('workspace');
  const ok = await working('正在打开示例工作台…', 'Opening the demo workspace…', async () => {
    const demo = await loadDemo((done, total) =>
      notice(
        '正在处理示例照片 ' + done + '/' + total + '…',
        'Processing sample photos ' + done + '/' + total + '…',
      ),
    );
    releaseWorkspace();
    state.albums = demo.albums;
    state.photos = demo.photos;
    state.sample = true;
    state.dirty = false;
    state.known = null;
    state.discover = null;
    state.plans = [];
    await runModel();
  });
  if (ok) scrollToArea(state.mode === 'known' ? 'review' : 'plans');
}
async function download(res) {
  const ok = await working(
    '正在打包原始照片副本…',
    'Packaging copies of the original photos…',
    async () => {
      const groups = res.groups
        .filter((g) => g.photoIds.length)
        .map((g) => ({ ...g, name: albumName(g) }));
      const zip = await exportAlbums(state.photos, groups);
      const url = URL.createObjectURL(zip);
      const anchor = el('a', { href: url, download: 'album-atlas.zip' });
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      unsavedReviews.delete(res);
      state.dirty =
        !state.sample && unsavedReviews.has(state[state.mode === 'known' ? 'discover' : 'known']);
      notice(
        'ZIP 已准备好，浏览器已收到下载请求。',
        'Your ZIP is ready. The browser has received the download.',
      );
    },
  );
  if (ok) byId('live').scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

for (const mode of ['known', 'discover'])
  byId(mode).addEventListener('click', () => {
    if (state.mode === mode) return;
    state.mode = mode;
    state.errors = [];
    notice(null);
    render();
  });
byId('demo').addEventListener('click', tryDemo);
byId('choose').addEventListener('click', () => looseInput.click());
looseInput.addEventListener('change', () => {
  const files = [...looseInput.files];
  looseInput.value = '';
  addFiles(files, 'loose');
});
folderInput.addEventListener('change', () => {
  const files = [...folderInput.files];
  folderInput.value = '';
  addFiles(files, 'folder');
});
refInput.addEventListener('change', () => {
  const files = [...refInput.files];
  refInput.value = '';
  addFiles(files, 'named', refName);
});
byId('name-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = byId('reference-name');
  refName = input.value.trim();
  if (!refName) {
    input.setCustomValidity(t('请输入相册名称。', 'Enter an album name.'));
    input.reportValidity();
    return;
  }
  byId('name-dialog').close();
  refInput.click();
});
byId('reference-name').addEventListener('input', (ev) => ev.target.setCustomValidity(''));
byId('group-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = byId('group-name'),
    name = input.value.trim(),
    res = state[state.mode];
  if (!name) {
    input.setCustomValidity(t('请输入相册名称。', 'Enter an album name.'));
    input.reportValidity();
    return;
  }
  rememberEdit(res);
  res.groups.push({ id: newGroupId(), name, photoIds: [] });
  res.edited = true;
  byId('group-dialog').close();
  changed();
  notice('已添加目的相册。', 'Destination album added.');
  render();
  scrollToArea('review');
});
byId('group-name').addEventListener('input', (ev) => ev.target.setCustomValidity(''));
for (const control of document.querySelectorAll('[data-close]'))
  control.addEventListener('click', () => byId(control.dataset.close).close());
byId('photo-dialog').addEventListener('close', () => {
  byId('full-photo').removeAttribute('src');
  if (previewOriginal) URL.revokeObjectURL(previewOriginal);
  previewOriginal = null;
});
byId('reset').addEventListener('click', () => byId('clear-dialog').showModal());
byId('clear-confirm').addEventListener('click', () => {
  byId('clear-dialog').close();
  releaseWorkspace();
  const mode = state.mode;
  state = fresh();
  state.mode = mode;
  draftIsCurrent = false;
  notice('工作台已清空。', 'Workspace cleared.');
  render();
  scrollToArea('workspace');
});
byId('language').addEventListener('click', () => {
  language = language === 'en' ? 'zh' : 'en';
  try {
    localStorage.setItem('atlas-language', language);
  } catch {
    /* usable without storage */
  }
  translate();
  render();
});
window.addEventListener('beforeunload', (ev) => {
  if (state.dirty) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});
byId('draft-save').addEventListener('click', async () => {
  if (
    storageState === 'saved' &&
    !window.confirm(
      t(
        '用当前照片和分组替换之前的本机草稿？',
        'Replace the saved draft with the current photos and groups?',
      ),
    )
  )
    return;
  await working('正在保存到本机…', 'Saving to this device…', async () => {
    const { mode, albums, photos, known, discover, plans } = state;
    await saveDraft({ version: 1, mode, albums, photos, known, discover, plans });
    storageState = 'saved';
    unsavedReviews = new WeakSet();
    state.dirty = false;
    draftIsCurrent = true;
    notice('已保存本机草稿。', 'Draft saved to this device.');
  });
});
byId('draft-load').addEventListener('click', async () => {
  if (
    (state.photos.length || state.albums.length) &&
    !window.confirm(
      t('用本机草稿替换当前工作台？', 'Replace the current workspace with the saved draft?'),
    )
  )
    return;
  const ok = await working('正在恢复本机草稿…', 'Restoring local draft…', async () => {
    const draft = await loadDraft();
    if (!draft) {
      storageState = 'empty';
      throw new Error(t('找不到本机草稿。', 'No saved draft was found.'));
    }
    if (draft.version !== 1 || !Array.isArray(draft.photos) || !Array.isArray(draft.albums))
      throw new Error(t('无法读取这份草稿。', 'This draft format cannot be read.'));
    const stored = [...draft.photos, ...draft.albums.flatMap((a) => a.photos)];
    if (!withinCapacity(stored.map((p) => p.blob))) {
      stored.forEach((p) => {
        if (p.url?.startsWith('blob:')) URL.revokeObjectURL(p.url);
      });
      throw new Error(
        t(
          '草稿超过工作台的 300 张或 512 MiB 限制。',
          'This draft exceeds the maximum of 300 photos or 512 MiB.',
        ),
      );
    }
    releaseWorkspace();
    state = { ...fresh(), ...draft, busy: true, dirty: false, sample: false };
    state.mode = draft.mode === 'discover' ? 'discover' : 'known';
    draftIsCurrent = true;
    notice('已恢复本机草稿。', 'Local draft restored.');
  });
  if (ok) scrollToArea('workspace');
});
byId('draft-clear').addEventListener('click', async () => {
  if (
    !window.confirm(
      t(
        '删除这个浏览器中保存的草稿？当前工作台和设备上的原图会保留。',
        'Delete this browser’s saved draft? Your current workspace and original files will stay in place.',
      ),
    )
  )
    return;
  await working('正在删除本机草稿…', 'Removing local draft…', async () => {
    await clearDraft();
    storageState = 'empty';
    if (draftIsCurrent) changed();
    notice('已删除本机草稿。', 'Local draft deleted.');
  });
});
hasDraft()
  .then((exists) => {
    storageState = exists ? 'saved' : 'empty';
    render();
  })
  .catch(() => {
    storageState = 'unavailable';
    render();
  });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {
    // The online workflow also works where service workers are disabled.
  });
}
translate();
render();
