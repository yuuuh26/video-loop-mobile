import { LoopPlayer, validRepeatCount } from './player.js';
import { LocalStore, DEFAULT_SETTINGS, inspectVideo } from './storage.js';
import { makeBackup, parseBackup, matchBackup } from './backup.js';

const $ = id => document.getElementById(id);
const video = $('video');
let store;
let entries = [];
let settings = { ...DEFAULT_SETTINGS };
let busy = false;
let mutationTail = Promise.resolve();
let toastTimer;
let selectionTimer;
let lastSelection = null;
let renderedSelection = null;
let wakeLock = null;
let wakePending = false;
let wakeDenied = false;
let wakeGeneration = 0;
let offlineReady = false;
let registration = null;
let updating = false;
let restoreData = null;

const player = new LoopPlayer(video, id => store.readBlob(id));
const labels = { empty: '動画を追加', loading: '読み込み中', paused: '一時停止', starting: '再生を開始中', playing: '再生中', buffering: '読み込み待ち', blocked: 'タップで再生', error: '再生エラー' };
const bytes = number => {
  if (number < 1024) return `${number} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(1)} KB`;
  if (number < 1024 ** 3) return `${(number / 1024 ** 2).toFixed(1)} MB`;
  return `${(number / 1024 ** 3).toFixed(2)} GB`;
};
const duration = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const stateValue = () => ({ schemaVersion: 1, settings: { ...settings }, order: entries.map(item => item.id), currentId: player.currentId });

function toast(message, long = false) {
  clearTimeout(toastTimer);
  // Put feedback in the active dialog's top layer so it remains visible and accessible.
  const activeDialog = document.activeElement?.closest('dialog[open]')
    ?? [...document.querySelectorAll('dialog[open]')].at(-1);
  (activeDialog ?? document.body).append($('toast'));
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, long ? 6500 : 3500);
}
function saveError(error) {
  return error?.name === 'QuotaExceededError'
    ? '端末の保存容量が不足しています。元動画を残したまま、不要なアプリ内コピーを削除してください。'
    : (error?.message || '保存できませんでした。既存の動画は自動削除しません。');
}
function queueMutation(task) {
  const action = mutationTail.catch(() => {}).then(async () => {
    busy = true; updateBusy();
    try { await task(); }
    finally { busy = false; updateBusy(); }
  });
  mutationTail = action;
  action.catch(error => toast(saveError(error), true));
  return action;
}
function updateBusy() {
  const unavailable = busy || !store;
  for (const id of ['add-videos', 'add-empty', 'export-backup', 'import-backup', 'keep-awake', 'apply-restore']) $(id).disabled = unavailable;
  $('repeat-count').disabled = unavailable;
  document.querySelectorAll('[data-mode],.item-actions button').forEach(button => {
    button.disabled = unavailable || button.dataset.boundary === 'true';
  });
  if (restoreData && $('restore-dialog').open) updateRestoreSummary();
}
function confirmAction(title, body, label, danger = false) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = label;
  $('confirm-ok').classList.toggle('danger', danger);
  return new Promise(resolve => {
    const done = answer => {
      dialog.removeEventListener('cancel', cancel);
      $('confirm-ok').removeEventListener('click', ok);
      $('confirm-cancel').removeEventListener('click', no);
      dialog.close(); resolve(answer);
    };
    const cancel = event => { event.preventDefault(); done(false); };
    const ok = () => done(true);
    const no = () => done(false);
    dialog.addEventListener('cancel', cancel);
    $('confirm-ok').addEventListener('click', ok);
    $('confirm-cancel').addEventListener('click', no);
    dialog.showModal();
  });
}

function renderPlayer() {
  const current = player.current;
  const loading = player.status === 'loading';
  $('video-position').textContent = current ? `${String(player.index + 1).padStart(2, '0')} / ${String(entries.length).padStart(2, '0')}` : 'YOUR LOOP';
  $('play-status').textContent = labels[player.status] ?? '';
  $('video-name').textContent = current?.name ?? 'まだ動画がありません';
  $('empty-player').hidden = Boolean(current);
  video.hidden = !current;
  $('player-message').textContent = player.message;
  $('player-message').hidden = !player.message;
  $('resume-overlay').hidden = player.status !== 'blocked';
  const playing = player.wantsPlay && ['playing', 'starting', 'buffering'].includes(player.status);
  $('play-symbol').textContent = playing ? 'Ⅱ' : '▶';
  $('play-label').textContent = playing ? '一時停止' : player.status === 'error' ? '再試行' : '再生';
  for (const id of ['play', 'previous', 'next', 'restart', 'fullscreen']) $(id).disabled = !current || loading;
  if (!current) $('repeat-progress').textContent = 'スマホの動画を複数選べます';
  else if (player.mode === 'single') $('repeat-progress').textContent = 'この動画を無限リピート';
  else $('repeat-progress').textContent = `完了 ${player.completed} / ${player.repeatCount} 回${playing ? ` · ${player.completed + 1}回目を再生中` : ''}`;
  if (renderedSelection !== player.currentId) {
    renderedSelection = player.currentId;
    document.querySelectorAll('#playlist li').forEach(row => {
      const active = row.dataset.id === player.currentId;
      row.classList.toggle('active', active);
      row.querySelector('.select-video').setAttribute('aria-current', active ? 'true' : 'false');
    });
  }
  if (player.currentId !== lastSelection) {
    lastSelection = player.currentId;
    clearTimeout(selectionTimer);
    if (store) selectionTimer = setTimeout(() => { void queueMutation(() => store.saveState(stateValue())); }, 200);
  }
  void updateWakeLock();
}
function renderSettings() {
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === settings.mode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('repeat-count').value = settings.repeatCount;
  $('count-settings').hidden = settings.mode !== 'count';
  $('count-help').textContent = settings.mode === 'count'
    ? '最後の動画まで進むと、最初に戻って繰り返します。'
    : '選んだ1本を、止めるまで繰り返します。';
  $('keep-awake').checked = settings.keepAwake;
}
function renderList() {
  $('playlist').replaceChildren();
  entries.forEach((item, index) => {
    const row = document.createElement('li');
    row.dataset.id = item.id;
    row.classList.toggle('active', player.currentId === item.id);
    const select = document.createElement('button');
    select.className = 'select-video';
    select.setAttribute('aria-current', String(player.currentId === item.id));
    const number = document.createElement('span'); number.className = 'item-number'; number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span'); copy.className = 'item-copy';
    const name = document.createElement('span'); name.className = 'item-name'; name.textContent = item.name;
    const meta = document.createElement('span'); meta.className = 'item-meta'; meta.textContent = `${duration(item.duration)} · ${bytes(item.size)} · 端末に保存済み`;
    copy.append(name, meta); select.append(number, copy);
    select.addEventListener('click', () => { void player.select(item.id, player.wantsPlay); });
    const actions = document.createElement('div'); actions.className = 'item-actions';
    for (const [label, symbol, delta] of [['上へ', '↑', -1], ['下へ', '↓', 1]]) {
      const button = document.createElement('button'); button.textContent = symbol;
      button.setAttribute('aria-label', `${item.name}を${label}`);
      button.title = label;
      button.dataset.boundary = String(index + delta < 0 || index + delta >= entries.length);
      button.addEventListener('click', () => { void queueMutation(async () => {
        const from = entries.findIndex(entry => entry.id === item.id), to = from + delta;
        if (from < 0 || to < 0 || to >= entries.length) return;
        const next = entries.slice(); [next[from], next[to]] = [next[to], next[from]];
        await store.saveState({ ...stateValue(), order: next.map(entry => entry.id) });
        entries = next; await player.setPlaylist(entries); renderList(); renderPlayer();
      }); });
      actions.append(button);
    }
    const remove = document.createElement('button'); remove.className = 'delete-button'; remove.textContent = '×';
    remove.setAttribute('aria-label', `${item.name}のアプリ内コピーを削除`); remove.title = 'アプリ内コピーを削除';
    remove.addEventListener('click', () => { void queueMutation(async () => {
      if (!await confirmAction('アプリ内の動画を削除', `「${item.name}」のコピーをこのアプリから削除します。スマホの元動画は削除しません。`, 'コピーを削除', true)) return;
      const currentRemoved = player.currentId === item.id;
      if (currentRemoved) player.pause();
      const at = entries.findIndex(entry => entry.id === item.id);
      await store.deleteVideo(item.id);
      entries = entries.filter(entry => entry.id !== item.id);
      const preferred = currentRemoved ? (entries[Math.min(at, entries.length - 1)]?.id ?? null) : player.currentId;
      await player.setPlaylist(entries, preferred);
      renderList(); renderPlayer();
      await store.saveState(stateValue());
      toast('アプリ内のコピーを削除しました'); await updateStorage();
    }); });
    actions.append(remove); row.append(select, actions); $('playlist').append(row);
  });
  renderedSelection = player.currentId;
  $('list-count').textContent = entries.length;
  $('empty-list').hidden = entries.length > 0;
  updateBusy();
}

async function importVideos(files) {
  $('import-status').hidden = false;
  $('import-results').hidden = true;
  $('import-results').replaceChildren();
  $('import-progress').max = files.length;
  $('import-progress').value = 0;
  let successful = 0;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    $('import-message').textContent = `${index + 1} / ${files.length} · ${file.name} を読み込み中`;
    let message, failed = false;
    try {
      const duplicate = entries.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified);
      if (duplicate && !await confirmAction('同じ動画の候補があります', `「${file.name}」は名前・サイズ・更新日時が一致する登録があります。別のコピーとして追加しますか？`, '追加する')) {
        message = `${file.name}：追加をスキップしました`;
      } else {
        const estimate = await navigator.storage?.estimate?.().catch(() => null);
        if (estimate?.quota && estimate.usage + file.size > estimate.quota) throw new DOMException('保存容量が不足しています。', 'QuotaExceededError');
        const info = await inspectVideo(file);
        const metadata = { id: crypto.randomUUID(), name: file.name, size: file.size, type: file.type, lastModified: file.lastModified ?? 0, duration: info.duration, width: info.width, height: info.height, addedAt: Date.now() };
        await store.addVideo(metadata, file);
        entries.push(metadata); successful++;
        message = `${file.name}：端末に保存済み`;
        await player.setPlaylist(entries); renderList(); renderPlayer();
      }
    } catch (error) { failed = true; message = `${file.name}：${saveError(error)}`; }
    const line = document.createElement('p'); line.textContent = message; line.classList.toggle('failed', failed); $('import-results').append(line);
    $('import-progress').value = index + 1;
  }
  $('import-status').hidden = true;
  $('import-results').hidden = false;
  if (successful) {
    try { await store.saveState(stateValue()); }
    catch (error) { toast(`動画は保存済みですが、順番の保存に失敗しました。${saveError(error)}`, true); }
    await requestPersistence(false);
  }
  await updateStorage();
}

async function setConfiguration(mode, count) {
  if (!validRepeatCount(count)) { renderSettings(); toast('再生回数は1以上の整数にしてください'); return; }
  const next = { ...settings, mode, repeatCount: Number(count) };
  try { await store.saveState({ ...stateValue(), settings: next }); }
  catch (error) { renderSettings(); throw error; }
  settings = next; renderSettings();
  await player.configure(mode, count);
}

async function updateStorage() {
  const total = entries.reduce((sum, item) => sum + item.size, 0);
  $('storage-summary').textContent = `${entries.length} 本 · ${bytes(total)} をこの端末に保存`;
  $('storage-detail').textContent = `このアプリの動画：${entries.length}本・${bytes(total)}`;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) $('storage-detail').textContent += `\n同じドメイン全体の使用量：${bytes(estimate.usage ?? 0)} / 上限目安 ${bytes(estimate.quota)}`;
  } catch {}
  $('storage-detail').classList.add('url-text');
  await refreshPersistence();
}
async function refreshPersistence() {
  if (!navigator.storage?.persisted) { $('persist-status').textContent = '保存保護：非対応'; $('request-persist').disabled = true; return; }
  try {
    const active = await navigator.storage.persisted();
    $('persist-status').textContent = active ? '永続ストレージ：有効' : '永続ストレージ：未許可';
    $('request-persist').disabled = active || !navigator.storage.persist;
  } catch { $('persist-status').textContent = '保存保護：状態を取得できません'; }
}
async function requestPersistence(showMessage = true) {
  if (!navigator.storage?.persist) { await refreshPersistence(); return; }
  try {
    const active = await navigator.storage.persist();
    if (showMessage) toast(active ? '保存データの保護が有効です' : '今回は許可されませんでした。元動画を残してください。', !active);
  } catch { if (showMessage) toast('保存保護を申請できませんでした'); }
  await refreshPersistence();
}

function wantsWake() {
  return settings.keepAwake && document.visibilityState === 'visible'
    && player.wantsPlay && ['playing', 'starting', 'buffering'].includes(player.status);
}
async function updateWakeLock() {
  if (!navigator.wakeLock) { $('awake-status').textContent = 'このブラウザでは非対応'; return; }
  if (!wantsWake()) {
    wakeGeneration++;
    if (wakeLock) { const lock = wakeLock; wakeLock = null; await lock.release().catch(() => {}); }
    $('awake-status').textContent = settings.keepAwake ? '再生中に点灯を維持します' : 'OFF';
    return;
  }
  if (wakeLock) { $('awake-status').textContent = '画面の点灯を維持中'; return; }
  if (wakePending) return;
  if (wakeDenied) { $('awake-status').textContent = '取得できませんでした・通常の画面設定を使用中'; return; }
  wakePending = true;
  const token = wakeGeneration;
  let stale = false;
  $('awake-status').textContent = '点灯維持を取得中';
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wantsWake() || token !== wakeGeneration) { stale = true; await lock.release(); return; }
    wakeLock = lock;
    $('awake-status').textContent = '画面の点灯を維持中';
    lock.addEventListener('release', () => {
      if (wakeLock !== lock) return;
      wakeLock = null; wakeDenied = true;
      $('awake-status').textContent = '点灯維持が解除されました';
    });
  } catch { wakeDenied = true; $('awake-status').textContent = '取得できませんでした・通常の画面設定を使用中'; }
  finally {
    wakePending = false;
    if (stale && wantsWake() && !wakeDenied) void updateWakeLock();
  }
}

function exportSettings() {
  const payload = JSON.stringify(makeBackup(entries, settings), null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const link = document.createElement('a');
  const date = new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  link.download = `video-loop-mobile-settings-${stamp}.json`; link.href = url;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('設定ファイルの保存を開始しました。動画本体は含みません。', true);
}
function openRestore(data) {
  restoreData = data;
  $('restore-items').replaceChildren();
  const matches = matchBackup(data.playlist, entries);
  matches.forEach(({ item, id, candidates }, index) => {
    const row = document.createElement('div'); row.className = 'restore-row';
    const label = document.createElement('label'); label.textContent = `${index + 1}. ${item.name} · ${duration(item.duration)} · ${bytes(item.size)}`;
    const select = document.createElement('select'); select.id = `restore-choice-${index}`;
    label.htmlFor = select.id;
    select.append(new Option('今回は復元しない / 動画が未追加', ''));
    entries.forEach(entry => select.append(new Option(`${entry.name} · ${duration(entry.duration)} · ${bytes(entry.size)}`, entry.id)));
    select.value = id;
    const note = document.createElement('small');
    note.textContent = id ? '名前・サイズ・更新日時・長さが一致する候補。内容も確認してください。'
      : candidates.length > 1 ? '一致する候補が複数あります。自分で選んでください。' : '一致する候補がありません。動画を追加するか、自分で選んでください。';
    select.addEventListener('change', updateRestoreSummary);
    row.append(label, select, note); $('restore-items').append(row);
  });
  updateRestoreSummary();
  $('settings-dialog').close(); $('restore-dialog').showModal();
}
function updateRestoreSummary() {
  const values = [...document.querySelectorAll('#restore-items select')].map(select => select.value).filter(Boolean);
  const duplicate = new Set(values).size !== values.length;
  $('restore-summary').textContent = duplicate ? '同じ登録動画が重複して割り当てられています。選び直してください。'
    : `${values.length} / ${restoreData?.playlist.length ?? 0} 本を割り当て。設定は ${restoreData?.settings.mode === 'count' ? `${restoreData.settings.repeatCount}回で次へ` : '1本を無限リピート'}。`;
  $('apply-restore').disabled = duplicate || busy || !store;
}
async function applyRestore() {
  if (!restoreData) return;
  const ids = [...document.querySelectorAll('#restore-items select')].map(select => select.value).filter(Boolean);
  if (new Set(ids).size !== ids.length || ids.some(id => !entries.some(item => item.id === id))) throw new Error('動画の割り当てを確認してください。');
  if (!await confirmAction('設定を復元しますか？', `回数・モードと、割り当てた${ids.length}本の順番を復元します。動画は削除しません。`, '復元する')) return;
  const ordered = [...ids.map(id => entries.find(item => item.id === id)), ...entries.filter(item => !ids.includes(item.id))];
  const nextSettings = { ...restoreData.settings };
  await store.saveState({ schemaVersion: 1, settings: nextSettings, order: ordered.map(item => item.id), currentId: ordered[0]?.id ?? null });
  player.pause(); entries = ordered; settings = nextSettings; wakeDenied = false;
  await player.configure(settings.mode, settings.repeatCount);
  await player.setPlaylist(entries);
  if (entries.length) await player.select(entries[0].id, false);
  renderSettings(); renderList(); renderPlayer();
  $('restore-dialog').close(); restoreData = null;
  toast('設定と順番を復元しました');
}

function renderOffline() {
  $('offline-status').textContent = offlineReady ? (navigator.onLine ? 'オフラインOK' : 'オフライン利用中') : 'オフライン準備中';
  $('offline-detail').textContent = offlineReady ? 'オフラインの準備ができています。通信を切っても、保存した動画を再生できます。'
    : 'オフライン起動の準備がまだ完了していません。通信中に一度アプリを開いてください。';
}
async function prepareOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    $('offline-status').textContent = 'オンラインで利用';
    $('offline-detail').textContent = 'この環境ではオフライン起動を利用できません。GitHub PagesのHTTPSで開いてください。';
    return;
  }
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    const showUpdate = () => { if (registration.waiting && navigator.serviceWorker.controller) $('apply-update').hidden = false; };
    showUpdate();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => { if (installing.state === 'installed') showUpdate(); });
    });
    // Only the worker belonging to this app may confirm offline readiness.
    const ready = await navigator.serviceWorker.ready;
    if (ready.scope !== new URL('./', location.href).href) throw new Error('worker scope mismatch');
    offlineReady = true; renderOffline();
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
  } catch {
    $('offline-status').textContent = 'オフライン準備未完了';
    $('offline-detail').textContent = 'オフライン準備に失敗しました。通信中にアプリを開き直してください。保存済み動画は削除しません。';
  }
}

function bindControls() {
  for (const id of ['add-empty', 'add-videos']) $(id).addEventListener('click', () => $('video-files').click());
  $('video-files').addEventListener('change', () => {
    const files = [...$('video-files').files]; $('video-files').value = '';
    if (files.length && store) void queueMutation(() => importVideos(files));
  });
  $('play').addEventListener('click', () => {
    wakeDenied = false;
    if (player.wantsPlay) player.pause(); else void player.play();
  });
  $('resume-overlay').addEventListener('click', () => { wakeDenied = false; void player.play(); });
  $('previous').addEventListener('click', () => { void player.move(-1); });
  $('next').addEventListener('click', () => { void player.move(1); });
  $('restart').addEventListener('click', () => { void player.restart(); });
  $('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('video-stage').requestFullscreen) await $('video-stage').requestFullscreen();
      else toast('このブラウザでは全画面に対応していません');
    } catch { toast('全画面表示を開始できませんでした'); }
  });
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.mode !== settings.mode) void queueMutation(() => setConfiguration(button.dataset.mode, settings.repeatCount));
  }));
  $('repeat-count').addEventListener('change', () => {
    const value = $('repeat-count').value;
    void queueMutation(() => setConfiguration(settings.mode, value));
  });
  $('open-settings').addEventListener('click', () => { $('settings-dialog').showModal(); void updateStorage(); });
  $('close-settings').addEventListener('click', () => $('settings-dialog').close());
  $('close-restore').addEventListener('click', () => $('restore-dialog').close());
  $('keep-awake').addEventListener('change', () => {
    const checked = $('keep-awake').checked;
    void queueMutation(async () => {
      const next = { ...settings, keepAwake: checked };
      try { await store.saveState({ ...stateValue(), settings: next }); }
      catch (error) { renderSettings(); throw error; }
      settings = next; wakeDenied = false; await updateWakeLock();
    });
  });
  $('request-persist').addEventListener('click', () => { void requestPersistence(); });
  $('export-backup').addEventListener('click', exportSettings);
  $('import-backup').addEventListener('click', () => $('backup-file').click());
  $('backup-file').addEventListener('change', () => {
    const file = $('backup-file').files[0]; $('backup-file').value = '';
    if (file) void queueMutation(async () => {
      if (file.size > 2_000_000) throw new Error('設定ファイルが大きすぎます。');
      openRestore(parseBackup(await file.text()));
    });
  });
  $('apply-restore').addEventListener('click', () => { void queueMutation(applyRestore); });
  const publicURL = new URL('./', location.href).href;
  $('public-url').textContent = publicURL;
  $('copy-url').addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(publicURL);
      else {
        const text = document.createElement('textarea'); text.value = publicURL; $('settings-dialog').append(text); text.select();
        const result = document.execCommand('copy'); text.remove(); if (!result) throw new Error('clipboard');
      }
      toast('URLをコピーしました');
    } catch { toast('コピーできませんでした。表示されているURLを選択してください。'); }
  });
  $('apply-update').addEventListener('click', async () => {
    if (!registration?.waiting) return;
    if (!await confirmAction('新しい版に更新', '再生を停止してアプリを開き直します。保存済み動画と設定は保持します。', '更新する')) return;
    await mutationTail.catch(() => {});
    player.pause(); updating = true; registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') player.pause();
    else { wakeDenied = false; void updateWakeLock(); }
  });
  window.addEventListener('pagehide', () => player.pause());
  window.addEventListener('online', renderOffline);
  window.addEventListener('offline', renderOffline);
  player.addEventListener('change', renderPlayer);
  video.addEventListener('play', () => { if (document.visibilityState !== 'visible') player.pause(); });
}

async function initialize() {
  bindControls(); renderSettings(); renderPlayer(); updateBusy();
  void prepareOffline();
  try {
    store = await LocalStore.open();
    const saved = await store.readAll(); entries = saved.entries;
    if (['single', 'count'].includes(saved.state.settings?.mode)) settings.mode = saved.state.settings.mode;
    if (validRepeatCount(saved.state.settings?.repeatCount)) settings.repeatCount = Number(saved.state.settings.repeatCount);
    if (typeof saved.state.settings?.keepAwake === 'boolean') settings.keepAwake = saved.state.settings.keepAwake;
    await player.configure(settings.mode, settings.repeatCount);
    await player.setPlaylist(entries, saved.state.currentId);
    renderSettings(); renderList(); renderPlayer();
    await updateStorage(); updateBusy();
  } catch (error) {
    store = null; updateBusy();
    $('player-message').hidden = false;
    $('player-message').textContent = `端末保存を利用できません。${saveError(error)} サイトデータは削除せず、Chromeで開き直してください。`;
    $('storage-summary').textContent = '端末保存を開けませんでした';
  }
}
void initialize();
