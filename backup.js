import { validRepeatCount } from './player.js';
export function makeBackup(entries, settings) {
  return {
    app: 'video-loop-mobile', schemaVersion: 1, exportedAt: new Date().toISOString(),
    includesVideos: false,
    settings: { mode: settings.mode, repeatCount: settings.repeatCount, keepAwake: settings.keepAwake },
    playlist: entries.map(item => ({ name: item.name, size: item.size, lastModified: item.lastModified ?? 0, duration: item.duration }))
  };
}
export function parseBackup(text) {
  if (text.length > 2_000_000) throw new Error('設定ファイルが大きすぎます。');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('正しいJSONファイルを選んでください。'); }
  if (data?.app !== 'video-loop-mobile' || data.schemaVersion !== 1 || data.includesVideos !== false) {
    throw new Error('VIDEO LOOP Mobileの設定バックアップではありません。');
  }
  if (!['single', 'count'].includes(data.settings?.mode) || !validRepeatCount(data.settings?.repeatCount)
    || typeof data.settings?.keepAwake !== 'boolean' || !Array.isArray(data.playlist) || data.playlist.length > 10000) {
    throw new Error('バックアップの設定値が不正です。');
  }
  const playlist = data.playlist.map(item => {
    if (!item || typeof item.name !== 'string' || item.name.length > 4096 || !Number.isSafeInteger(item.size)
      || item.size <= 0 || !Number.isFinite(item.duration) || item.duration <= 0
      || !Number.isSafeInteger(item.lastModified) || item.lastModified < 0) throw new Error('動画情報が不正です。');
    return { name: item.name, size: item.size, lastModified: item.lastModified, duration: item.duration };
  });
  return { settings: { mode: data.settings.mode, repeatCount: Number(data.settings.repeatCount), keepAwake: data.settings.keepAwake }, playlist };
}
export function matchBackup(playlist, entries) {
  const used = new Set();
  return playlist.map(item => {
    const candidates = entries.filter(entry => !used.has(entry.id) && entry.name === item.name
      && entry.size === item.size && (entry.lastModified ?? 0) === item.lastModified
      && Math.abs(entry.duration - item.duration) < 0.1);
    const id = candidates.length === 1 ? candidates[0].id : '';
    if (id) used.add(id);
    return { item, id, candidates };
  });
}
