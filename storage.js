export const DB_NAME = 'yuu-video-loop-mobile-v1';
export const DEFAULT_SETTINGS = Object.freeze({ mode: 'single', repeatCount: 3, keepAwake: true });

export function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('保存処理が中断されました。')), { once: true });
    transaction.addEventListener('error', () => {}, { once: true });
  });
}
function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('端末の保存データを読み込めません。'));
  });
}

export class LocalStore {
  constructor(db) { this.db = db; }
  static open(factory = globalThis.indexedDB) {
    return new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('この環境では端末保存を利用できません。Chromeで開いてください。')); return; }
      let blocked = false;
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('videos', { keyPath: 'id' });
        db.createObjectStore('blobs', { keyPath: 'id' });
        db.createObjectStore('state');
      };
      request.onerror = () => reject(request.error ?? new Error('端末保存を開けません。'));
      request.onblocked = () => { blocked = true; reject(new Error('別のタブで開いているアプリを閉じて、再読み込みしてください。')); };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => db.close();
        resolve(new LocalStore(db));
      };
    });
  }
  async readAll() {
    const tx = this.db.transaction(['videos', 'state'], 'readonly');
    const done = transactionDone(tx);
    const videos = requestValue(tx.objectStore('videos').getAll());
    const state = requestValue(tx.objectStore('state').get('app'));
    const [, entries, saved] = await Promise.all([done, videos, state]);
    const order = Array.isArray(saved?.order) ? saved.order : [];
    const positions = new Map(order.map((id, index) => [id, index]));
    entries.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity) || a.addedAt - b.addedAt);
    return { entries, state: saved ?? {} };
  }
  async readBlob(id) {
    const tx = this.db.transaction('blobs', 'readonly');
    const done = transactionDone(tx);
    const [, result] = await Promise.all([done, requestValue(tx.objectStore('blobs').get(id))]);
    return result?.blob;
  }
  async addVideo(metadata, blob) {
    const tx = this.db.transaction(['videos', 'blobs'], 'readwrite');
    const done = transactionDone(tx);
    try {
      tx.objectStore('videos').add(metadata);
      tx.objectStore('blobs').add({ id: metadata.id, blob });
    } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
    await done;
  }
  async deleteVideo(id) {
    const tx = this.db.transaction(['videos', 'blobs'], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('videos').delete(id);
    tx.objectStore('blobs').delete(id);
    await done;
  }
  async saveState(value) {
    const tx = this.db.transaction('state', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('state').put(value, 'app');
    await done;
  }
}

export async function inspectVideo(file, documentRef = document, urls = URL) {
  if (!(file instanceof Blob) || !file.size) throw new Error('空のファイルは追加できません。');
  const probe = documentRef.createElement('video');
  probe.preload = 'auto';
  probe.muted = true;
  probe.playsInline = true;
  const url = urls.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const fail = (message) => { cleanup(); reject(new Error(message)); };
      const loaded = () => {
        if (!Number.isFinite(probe.duration) || probe.duration <= 0 || !probe.videoWidth || !probe.videoHeight) {
          fail('動画の長さや映像を読み込めません。'); return;
        }
        cleanup(); resolve({ duration: probe.duration, width: probe.videoWidth, height: probe.videoHeight });
      };
      const error = () => fail('この端末で再生できない形式、または破損した動画です。');
      const timer = setTimeout(() => fail('読み込みが完了しませんでした。ファイルを確認してください。'), 20000);
      const cleanup = () => {
        clearTimeout(timer);
        probe.removeEventListener('loadeddata', loaded);
        probe.removeEventListener('error', error);
      };
      probe.addEventListener('loadeddata', loaded);
      probe.addEventListener('error', error);
      probe.src = url;
      probe.load();
    });
  } finally {
    probe.pause(); probe.removeAttribute('src'); probe.load();
    urls.revokeObjectURL(url);
  }
}
