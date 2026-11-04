const database = 'album-atlas-workspace-v1';
const store = 'saved';

async function access(mode, operation) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const result = operation(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(result.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error || result.error || new Error('Draft transaction failed'));
    });
  } finally { db.close(); }
}

function mapPhotos(state, map) {
  return {...state, photos:state.photos.map(map), albums:state.albums.map(album => ({...album, photos:album.photos.map(map)}))};
}

export async function saveDraft(state) {
  const snapshot = mapPhotos(state, ({url, ...photo}) => photo);
  // Replace the previous draft atomically. A quota failure retains the old copy.
  await access('readwrite', table => table.put(snapshot, 'current'));
}

export async function loadDraft() {
  const state = await access('readonly', table => table.get('current'));
  if (!state) return undefined;
  if (state.version !== 1 || !Array.isArray(state.photos) || !Array.isArray(state.albums)) throw new Error('Unsupported draft version');
  return mapPhotos(state, p => ({...p, url:URL.createObjectURL(p.thumb || p.blob)}));
}

export async function clearDraft() {
  await access('readwrite', table => table.delete('current'));
}

export async function hasDraft() {
  return Boolean(await access('readonly', table => table.count('current')));
}
