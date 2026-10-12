import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopPlayer, validRepeatCount } from '../player.js';

class Video extends EventTarget {
  constructor() {
    super(); this.src = ''; this.currentSrc = ''; this.readyState = 0; this.duration = 1;
    this.paused = true; this.ended = false; this.loop = false; this._time = 0;
    this.playFailure = null; this.delayPlay = null; this.plays = 0;
  }
  get currentTime() { return this._time; }
  set currentTime(value) {
    this._time = value; this.ended = false;
    this.dispatchEvent(new Event('seeking'));
    this.dispatchEvent(new Event('seeked'));
  }
  load() { this.currentSrc = this.src; this.readyState = this.src ? 2 : 0; this._time = 0; this.ended = false; }
  removeAttribute(key) { if (key === 'src') this.src = ''; }
  async play() {
    this.plays++;
    if (this.playFailure) throw this.playFailure;
    if (this.delayPlay) await this.delayPlay;
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
  }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  finish() { this.ended = true; this.paused = true; this.dispatchEvent(new Event('pause')); this.dispatchEvent(new Event('ended')); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const list = ['A', 'B', 'C'].map(id => ({ id, name: id + '.mp4' }));
function setup(read = async () => new Blob(['video'])) {
  const video = new Video(); let sequence = 0;
  const live = new Set(); const revoked = [];
  const urls = {
    createObjectURL() { const url = `blob:test-${++sequence}`; live.add(url); return url; },
    revokeObjectURL(url) { live.delete(url); revoked.push(url); }
  };
  const player = new LoopPlayer(video, read, urls);
  return { video, player, live, revoked };
}

test('repeat count validates integer semantics and safe range', () => {
  for (const n of [1, 3, '7', ' 12 ', 1000000]) assert.equal(validRepeatCount(n), true);
  for (const n of ['', 0, -1, 1.5, 'NaN', '2e2', '3.0', Infinity, '9007199254740992', null, undefined]) assert.equal(validRepeatCount(n), false);
});
test('loading selects first video but never starts sound automatically', async () => {
  const { video, player } = setup(); await player.setPlaylist(list);
  assert.equal(player.currentId, 'A'); assert.equal(player.status, 'paused'); assert.equal(video.plays, 0);
  player.destroy();
});
test('3 videos repeat exactly 3 times and wrap indefinitely', async () => {
  const { video, player } = setup(); await player.configure('count', 3); await player.setPlaylist(list); await player.play();
  assert.equal(video.loop, false);
  const seen = [];
  for (let n = 0; n < 900; n++) { seen.push(player.currentId); video.finish(); await tick(); }
  for (let n = 0; n < seen.length; n++) assert.equal(seen[n], ['A','B','C'][Math.floor(n / 3) % 3]);
  assert.equal(player.currentId, 'A'); assert.equal(player.completed, 0); player.destroy();
});
test('count 1 moves on first full pass', async () => {
  const { video, player } = setup(); await player.configure('count', 1); await player.setPlaylist(list); await player.play();
  video.finish(); await tick(); assert.equal(player.currentId, 'B'); player.destroy();
});
test('one video at count 1 remains a working infinite playlist', async () => {
  const { video, player } = setup(); await player.configure('count', 1); await player.setPlaylist(list.slice(0,1)); await player.play();
  for (let i=0;i<100;i++){ video.finish(); await tick(); assert.equal(player.currentId, 'A'); assert.equal(player.status,'playing'); }
  player.destroy();
});
test('single mode uses native loop and keeps selected video', async () => {
  const { video, player } = setup(); await player.setPlaylist(list); await player.select('B'); await player.play();
  assert.equal(video.loop, true); assert.equal(player.currentId, 'B');
  // Fallback even if a decoder unexpectedly reports an ending.
  video.finish(); await tick(); assert.equal(player.currentId, 'B'); assert.equal(player.completed,0); player.destroy();
});
test('pause and resume preserve completed count and never advance', async () => {
  const { video, player } = setup(); await player.configure('count', 3); await player.setPlaylist(list); await player.play();
  video.finish(); await tick(); assert.equal(player.completed,1);
  player.pause(); assert.equal(player.completed,1); assert.equal(player.status,'paused');
  await player.play(); assert.equal(player.completed,1); player.destroy();
});
test('manual next resets per-video count without adding a completion', async () => {
  const { video, player } = setup(); await player.configure('count', 3); await player.setPlaylist(list); await player.play();
  video.finish(); await tick(); await player.move(1);
  assert.equal(player.currentId,'B'); assert.equal(player.completed,0); player.destroy();
});
test('manual seek to end does not count and following full pass does', async () => {
  const { video, player } = setup(); await player.configure('count', 2); await player.setPlaylist(list); await player.play();
  video.currentTime = 0.99; video.finish(); await tick();
  assert.equal(player.currentId,'A'); assert.equal(player.completed,0);
  video.finish(); await tick(); assert.equal(player.completed,1); player.destroy();
});
test('duplicate ending cannot add a completion twice', async () => {
  const { video, player } = setup(); await player.configure('count', 3); await player.setPlaylist(list); await player.play();
  video.finish(); video.dispatchEvent(new Event('ended')); await tick(); assert.equal(player.completed,1); player.destroy();
});
test('configuration changes reset count and keep paused playback paused', async () => {
  const { video, player } = setup(); await player.configure('count',3); await player.setPlaylist(list); await player.play();
  video.finish(); await tick(); player.pause();
  await player.configure('count',4); assert.equal(player.completed,0); assert.equal(player.status,'paused');
  await player.configure('single',4); assert.equal(video.loop,true); player.destroy();
});
test('a stale Blob read cannot overwrite a newer selected source', async () => {
  let resolveA; const pending = new Promise(resolve => { resolveA = resolve; });
  const { player, live } = setup(id => id === 'A' ? pending : Promise.resolve(new Blob([id])));
  const initial = player.setPlaylist(list); await tick();
  await player.select('C', false); resolveA(new Blob(['A'])); await initial;
  assert.equal(player.currentId,'C'); assert.equal(live.size,1); player.destroy(); assert.equal(live.size,0);
});
test('all obsolete source URLs are revoked while switching repeatedly', async () => {
  const { player, live, revoked } = setup(); await player.setPlaylist(list);
  for(let i=0;i<100;i++) await player.move(1);
  assert.equal(live.size,1); assert.equal(revoked.length,100); player.destroy(); assert.equal(live.size,0);
});
test('read failure leaves playlist intact and allows selecting another file', async () => {
  const { player } = setup(id => id==='A' ? Promise.reject(new Error('read')) : Promise.resolve(new Blob(['good'])));
  await player.setPlaylist(list); assert.equal(player.status,'error'); assert.equal(player.items.length,3);
  await player.select('B'); assert.equal(player.status,'paused'); player.destroy();
});
test('autoplay rejection presents blocked state without retrying forever', async () => {
  const { video, player } = setup(); await player.setPlaylist(list);
  video.playFailure = new DOMException('blocked','NotAllowedError'); await player.play();
  assert.equal(player.status,'blocked'); assert.equal(player.completed,0); assert.equal(video.plays,1);
  video.playFailure=null; await player.play(); assert.equal(player.status,'playing'); player.destroy();
});
test('failed playback never counts a completed pass', async () => {
  const { video, player } = setup(); await player.configure('count',2); await player.setPlaylist(list);
  video.playFailure = new Error('decode'); await player.play();
  video.finish(); await tick(); assert.equal(player.completed,0); assert.equal(player.currentId,'A'); player.destroy();
});
test('deletion of selected video stops and chooses valid neighbour', async () => {
  const { player } = setup(); await player.setPlaylist(list); await player.play();
  await player.setPlaylist(list.slice(1), 'B');
  assert.equal(player.currentId,'B'); assert.equal(player.status,'paused');
  await player.setPlaylist([]); assert.equal(player.status,'empty'); assert.equal(player.currentId,null); player.destroy();
});
test('reordering keeps selected video and playback progress', async () => {
  const { video, player } = setup(); await player.configure('count',3); await player.setPlaylist(list); await player.play();
  video.finish(); await tick(); await player.setPlaylist([list[2],list[0],list[1]]);
  assert.equal(player.currentId,'A'); assert.equal(player.completed,1); assert.equal(player.status,'playing'); player.destroy();
});
test('pause while play promise is pending wins over late resolution', async () => {
  const { video, player } = setup(); await player.setPlaylist(list);
  let resolve; video.delayPlay = new Promise(done => { resolve = done; });
  const pending = player.play(); player.pause(); resolve(); await pending;
  assert.equal(player.wantsPlay,false); assert.equal(video.paused,true); player.destroy();
});
