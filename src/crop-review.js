import { scanCrops } from './crop-scan.js';

const PAGE_SIZE = 6;

// Review state is ephemeral and deliberately separate from the export and draft models.
export function createCropReview(t) {
  const shelf = document.createElement('section');
  shelf.id = 'crop-review';
  shelf.setAttribute('aria-labelledby', 'crop-heading');
  shelf.innerHTML = `<div class="crop-shelf-head"><div><h3 id="crop-heading"></h3><p class="note" id="crop-description"></p>
    <a id="crop-practice" class="crop-practice" href="./docs/crop-practice.zip" download="crop-practice.zip"></a></div>
    <div class="crop-actions"><button type="button" id="crop-start" class="button outline"></button>
    <button type="button" id="crop-cancel" class="button quiet" hidden></button></div></div>
    <p id="crop-status" class="note" role="status" aria-live="polite"></p><progress id="crop-progress" hidden></progress>
    <p id="crop-truncated" class="crop-warning" hidden></p><ul id="crop-list"></ul>
    <div id="crop-paging" hidden><button type="button" id="crop-prev" class="button quiet"></button><span class="meta" id="crop-page"></span>
    <button type="button" id="crop-next" class="button quiet"></button></div>`;
  const dialog = document.createElement('dialog');
  dialog.id = 'crop-dialog';
  dialog.setAttribute('aria-labelledby', 'crop-dialog-title');
  dialog.setAttribute('aria-describedby', 'crop-dialog-hint');
  dialog.innerHTML = `<div class="crop-dialog-head"><div><p id="crop-pair-number" class="meta"></p><h2 id="crop-dialog-title"></h2></div>
    <button type="button" id="crop-close" class="button quiet" autofocus></button></div>
    <p id="crop-dialog-hint"></p><div class="crop-zoom" role="group"><span id="crop-zoom-label"></span>
    <button type="button" data-crop-zoom="fit"></button><button type="button" data-crop-zoom="1">100%</button>
    <button type="button" data-crop-zoom="2">200%</button></div>
    <div class="crop-plates"></div><p class="note" id="crop-evidence"></p>
    <div class="crop-dialog-foot"><p class="note" id="crop-export-note"></p><button id="crop-reviewed" type="button" class="button primary"></button></div>`;
  document.body.append(dialog);
  const $ = (id) => shelf.querySelector('#' + id) ?? dialog.querySelector('#' + id);
  const plates = dialog.querySelector('.crop-plates');
  let photos = [],
    byId = new Map(),
    appBusy = false;
  let state = 'idle',
    run = null,
    progress = null,
    result = null,
    error = null,
    page = 0;
  let opened = null,
    zoom = 'fit',
    originalUrls = [];
  const seen = new Set();

  function setStatus() {
    shelf.dataset.cropState = state;
    const bar = $('crop-progress');
    bar.hidden = state !== 'scanning';
    let message = '';
    if (state === 'scanning') {
      const { phase, completed, total } = progress;
      bar.max = Math.max(1, total);
      bar.value = completed;
      const name =
        phase === 'encoding' ? t('读取画面', 'Reading images') : t('比较图片对', 'Comparing pairs');
      bar.setAttribute('aria-label', name);
      message = name + ' · ' + completed + ' / ' + total;
    } else if (state === 'done') {
      const n = result.pairs.length;
      message = n
        ? t(
            '本次列出 ' + n + ' 对候选，已核看 ' + seen.size + ' 对。',
            n + ' candidate pairs listed · ' + seen.size + ' reviewed.',
          )
        : t('本次扫描未发现裁剪候选。', 'No crop candidates found in this scan.');
    } else if (state === 'canceled') {
      message = t('扫描已取消。', 'Scan canceled.');
    } else if (state === 'error') {
      message =
        error?.name === 'NotSupportedError'
          ? t(
              '此浏览器不支持后台裁剪扫描。普通副本复核和导出仍可使用。',
              'Background crop scanning is unavailable in this browser. Standard duplicate review and export are available.',
            )
          : t('裁剪扫描未完成，可以重试。', 'The crop scan could not finish. You can retry.');
    }
    if ($('crop-status').textContent !== message) $('crop-status').textContent = message;
    $('crop-truncated').hidden = !result?.truncated;
    $('crop-truncated').textContent = result?.truncated
      ? t(
          '至少发现 ' + result.atLeast + ' 对候选，仅列出前 ' + result.pairs.length + ' 对。',
          'At least ' +
            result.atLeast +
            ' candidate pairs were found. Only the first ' +
            result.pairs.length +
            ' are listed.',
        )
      : '';
  }

  function pairButton(pair, index) {
    const original = byId.get(pair.originalId),
      crop = byId.get(pair.cropId);
    if (!original || !crop) return document.createDocumentFragment();
    const li = document.createElement('li'),
      button = document.createElement('button');
    button.type = 'button';
    button.dataset.cropPair = String(index);
    button.className = 'crop-pair';
    button.setAttribute(
      'aria-label',
      t('对照 ', 'Compare ') +
        original.name +
        ' / ' +
        crop.name +
        (seen.has(index) ? t('，已核看', ', reviewed') : ''),
    );
    const thumbnails = document.createElement('span');
    thumbnails.className = 'crop-thumbs';
    for (const photo of [original, crop]) {
      const img = document.createElement('img');
      img.src = photo.url;
      img.alt = '';
      img.loading = 'lazy';
      thumbnails.append(img);
    }
    const names = document.createElement('span');
    names.className = 'crop-pair-names';
    for (const photo of [original, crop]) {
      const name = document.createElement('span');
      name.textContent = photo.name;
      names.append(name);
    }
    const action = document.createElement('span');
    action.className = 'crop-pair-action';
    action.textContent = seen.has(index) ? t('已核看 ✓', 'Reviewed ✓') : t('对照 →', 'Compare →');
    button.append(thumbnails, names, action);
    button.onclick = () => openPair(index);
    li.append(button);
    return li;
  }

  function paint() {
    shelf.hidden = photos.length < 2;
    $('crop-heading').textContent = t('裁剪对照', 'Crop comparisons');
    $('crop-description').textContent = t(
      '手动查找散图中的裁剪版本，在原图上核对取景范围。最多列出 60 对，导出仍按现有选择进行。',
      'Scan unsorted photos for reframed versions and inspect the estimated crop. Review up to 60 pairs. Your export choices stay as set.',
    );
    $('crop-practice').textContent = t('下载裁剪练习图片（ZIP）', 'Download crop practice photos (ZIP)');
    const start = $('crop-start');
    start.hidden = state === 'scanning';
    start.disabled = appBusy || photos.length < 2;
    start.textContent =
      state === 'idle' ? t('查找裁剪候选', 'Find possible crops') : t('重新扫描', 'Scan again');
    const cancel = $('crop-cancel');
    cancel.hidden = state !== 'scanning';
    cancel.textContent = t('取消扫描', 'Cancel scan');
    setStatus();
    const pairs = result?.pairs ?? [],
      first = page * PAGE_SIZE;
    $('crop-list').replaceChildren(
      ...pairs.slice(first, first + PAGE_SIZE).map((p, i) => pairButton(p, first + i)),
    );
    $('crop-paging').hidden = pairs.length <= PAGE_SIZE;
    $('crop-page').textContent =
      first + 1 + '–' + Math.min(first + PAGE_SIZE, pairs.length) + ' / ' + pairs.length;
    $('crop-prev').textContent = t('上一页', 'Previous');
    $('crop-next').textContent = t('下一页', 'Next');
    $('crop-prev').disabled = page === 0;
    $('crop-next').disabled = first + PAGE_SIZE >= pairs.length;
    if (dialog.open) translateDialog();
  }

  function stop() {
    const previous = run;
    run = null;
    previous?.abort();
  }
  function releaseImages() {
    plates.replaceChildren();
    for (const url of originalUrls) URL.revokeObjectURL(url);
    originalUrls = [];
  }
  function invalidate() {
    stop();
    opened = null;
    if (dialog.open) dialog.close();
    releaseImages();
    state = 'idle';
    result = null;
    error = null;
    page = 0;
    seen.clear();
    paint();
  }
  async function startScan() {
    if (run || appBusy || photos.length < 2) return;
    result = null;
    error = null;
    page = 0;
    seen.clear();
    const controller = new AbortController();
    run = controller;
    progress = { phase: 'encoding', completed: 0, total: photos.length };
    state = 'scanning';
    paint();
    $('crop-cancel').focus({ preventScroll: true });
    try {
      const answer = await scanCrops(photos, {
        signal: controller.signal,
        onProgress: (update) => {
          if (run === controller) {
            progress = update;
            setStatus();
          }
        },
      });
      if (run !== controller) return;
      result = answer;
      state = 'done';
    } catch (failure) {
      if (run !== controller) return;
      error = failure;
      state = failure?.name === 'AbortError' ? 'canceled' : 'error';
    } finally {
      if (run === controller) {
        const hadFocus = document.activeElement === $('crop-cancel');
        run = null;
        paint();
        if (hadFocus)
          (shelf.querySelector('[data-crop-pair]') ?? $('crop-start')).focus({ preventScroll: true });
      }
    }
  }

  function zoomTo(value) {
    zoom = value;
    for (const b of dialog.querySelectorAll('[data-crop-zoom]'))
      b.setAttribute('aria-pressed', String(b.dataset.cropZoom === zoom));
    for (const figure of plates.children) {
      const viewport = figure.querySelector('.crop-viewport'),
        surface = viewport.firstElementChild,
        img = surface.querySelector('img');
      const photo = byId.get(figure.dataset.photoId);
      const w = img.naturalWidth || photo.width,
        h = img.naturalHeight || photo.height;
      surface.style.setProperty('--crop-aspect', String(w / h));
      surface.style.width = zoom === 'fit' ? '' : Math.round(w * Number(zoom)) + 'px';
      const pair = result.pairs[opened],
        isOriginal = figure.dataset.cropRole === 'original';
      const centerX = isOriginal ? pair.box.x + pair.box.w / 2 : 0.5,
        centerY = isOriginal ? pair.box.y + pair.box.h / 2 : 0.5;
      viewport.scrollLeft = surface.offsetWidth * centerX - viewport.clientWidth / 2;
      viewport.scrollTop = surface.offsetHeight * centerY - viewport.clientHeight / 2;
    }
  }
  function photoPlate(photo, role, box) {
    const figure = document.createElement('figure');
    figure.dataset.cropRole = role;
    figure.dataset.photoId = photo.id;
    const caption = document.createElement('figcaption');
    const title = document.createElement('strong'),
      detail = document.createElement('span');
    detail.textContent = photo.name + ' · ' + photo.width + ' × ' + photo.height;
    caption.append(title, detail);
    const viewport = document.createElement('div'),
      surface = document.createElement('div'),
      img = document.createElement('img');
    viewport.className = 'crop-viewport';
    viewport.tabIndex = 0;
    surface.className = 'crop-surface';
    surface.style.setProperty('--crop-aspect', String(photo.width / photo.height));
    img.alt = photo.name;
    const url = URL.createObjectURL(photo.blob);
    originalUrls.push(url);
    img.onload = () => {
      if (dialog.open && img.isConnected) zoomTo(zoom);
    };
    img.onerror = () => {
      if (img.isConnected) figure.classList.add('crop-load-error');
    };
    img.src = url;
    surface.append(img);
    if (box) {
      const mark = document.createElement('span');
      mark.dataset.cropBox = '';
      mark.setAttribute('aria-hidden', 'true');
      Object.assign(mark.style, {
        left: box.x * 100 + '%',
        top: box.y * 100 + '%',
        width: box.w * 100 + '%',
        height: box.h * 100 + '%',
      });
      surface.append(mark);
    }
    const failed = document.createElement('p');
    failed.className = 'crop-file-error';
    viewport.append(surface);
    figure.append(caption, viewport, failed);
    return figure;
  }
  function translateDialog() {
    if (opened === null || !result) return;
    $('crop-pair-number').textContent = t('候选 ', 'Pair ') + (opened + 1) + ' / ' + result.pairs.length;
    $('crop-dialog-title').textContent = t('逐图对照', 'Compare originals');
    $('crop-dialog-hint').textContent = t(
      '框线是估计的取景范围。请放大核对小字、日期和局部改动。看起来相似的图也可能表达不同信息。',
      'The frame estimates the crop. Zoom in to check fine print, dates and edits. Similar pictures can carry different information.',
    );
    $('crop-close').textContent = t('关闭对照', 'Close comparison');
    $('crop-zoom-label').textContent = t('缩放', 'Zoom');
    dialog.querySelector('.crop-zoom').setAttribute('aria-labelledby', 'crop-zoom-label');
    dialog.querySelector('[data-crop-zoom="fit"]').textContent = t('适应窗口', 'Fit');
    for (const figure of plates.children) {
      const name =
        figure.dataset.cropRole === 'original'
          ? t('原图 · 估计区域', 'Original · estimated region')
          : t('可能的裁剪版本', 'Possible cropped version');
      figure.querySelector('strong').textContent = name;
      figure
        .querySelector('.crop-viewport')
        .setAttribute('aria-label', name + ' · ' + t('可滚动', 'scrollable'));
      figure.querySelector('.crop-file-error').textContent = t(
        '无法预览这份原文件。',
        'This original could not be displayed.',
      );
    }
    const { w, h } = result.pairs[opened].box;
    const width = Math.round(w * 100) + '%',
      height = Math.round(h * 100) + '%';
    $('crop-evidence').textContent = t(
      '估计区域占原图宽度的 ' + width + '、高度的 ' + height + '。放大后可分别滚动两张原图。',
      'The estimated region spans ' +
        width +
        ' of the original width and ' +
        height +
        ' of its height. At higher zoom, scroll each image independently.',
    );
    $('crop-export-note').textContent = t(
      '核看标记仅用于本次对照，导出沿用现有选择。',
      'Review marks last for this scan and leave export choices unchanged.',
    );
    $('crop-reviewed').textContent = seen.has(opened)
      ? t('已核看 · 返回', 'Reviewed · return')
      : t('标记已核看', 'Mark reviewed');
  }
  function openPair(index) {
    const pair = result?.pairs[index];
    if (!pair) return;
    releaseImages();
    opened = index;
    plates.append(
      photoPlate(byId.get(pair.originalId), 'original', pair.box),
      photoPlate(byId.get(pair.cropId), 'crop', null),
    );
    translateDialog();
    dialog.showModal();
    zoomTo('fit');
    $('crop-close').focus({ preventScroll: true });
  }
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const last = opened;
    opened = null;
    releaseImages();
    if (last !== null) {
      paint();
      (shelf.querySelector('[data-crop-pair="' + last + '"]') ?? $('crop-start')).focus({
        preventScroll: true,
      });
    }
  });
  $('crop-close').onclick = () => dialog.close();
  $('crop-reviewed').onclick = () => {
    if (opened !== null) seen.add(opened);
    setStatus();
    dialog.close();
  };
  for (const b of dialog.querySelectorAll('[data-crop-zoom]')) b.onclick = () => zoomTo(b.dataset.cropZoom);
  $('crop-start').onclick = startScan;
  $('crop-cancel').onclick = () => {
    stop();
    state = 'canceled';
    paint();
    $('crop-start').focus({ preventScroll: true });
  };
  $('crop-prev').onclick = () => {
    page--;
    paint();
    (shelf.querySelector('[data-crop-pair]') ?? $('crop-start')).focus({ preventScroll: true });
  };
  $('crop-next').onclick = () => {
    page++;
    paint();
    (shelf.querySelector('[data-crop-pair]') ?? $('crop-start')).focus({ preventScroll: true });
  };
  return {
    invalidate,
    release() {
      photos = [];
      byId.clear();
      invalidate();
    },
    render(nextPhotos, busy) {
      appBusy = busy;
      if (nextPhotos.length !== photos.length || nextPhotos.some((p, i) => p !== photos[i])) {
        photos = [...nextPhotos];
        byId = new Map(photos.map((p) => [p.id, p]));
        invalidate();
      } else paint();
      return shelf;
    },
  };
}
