// Playback uses media events, never elapsed-time guesses. No network operations.
export function validRepeatCount(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return false;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 1;
}

export class LoopPlayer extends EventTarget {
  constructor(video, readBlob, urls = URL) {
    super();
    this.video = video;
    this.readBlob = readBlob;
    this.urls = urls;
    this.items = [];
    this.currentId = null;
    this.mode = 'single';
    this.repeatCount = 3;
    this.completed = 0;
    this.status = 'empty';
    this.message = '';
    this.wantsPlay = false;
    this.serial = 0;
    this.playSerial = 0;
    this.pendingPlay = null;
    this.url = null;
    this.armed = false;
    this.validCycle = true;
    this.internalSeek = false;
    this.cancelMetadata = null;
    this.listeners = [];
    this.listen('play', () => {
      if (!this.isCurrent() || this.status === 'loading') return;
      if (this.pendingPlay && (!this.wantsPlay || this.pendingPlay.token !== this.serial || this.pendingPlay.attempt !== this.playSerial)) {
        video.pause(); return;
      }
      this.wantsPlay = true;
      this.status = 'starting';
      this.emit();
    });
    this.listen('playing', () => {
      if (!this.isCurrent() || this.status === 'loading') return;
      if (!this.wantsPlay) { video.pause(); return; }
      this.internalSeek = false;
      this.armed = true;
      this.status = 'playing';
      this.message = '';
      this.emit();
    });
    this.listen('pause', () => {
      if (!this.isCurrent() || this.status === 'loading' || video.ended) return;
      this.playSerial++;
      this.wantsPlay = false;
      if (this.status !== 'error' && this.status !== 'blocked') this.status = 'paused';
      this.emit();
    });
    this.listen('seeking', () => {
      if (!this.isCurrent() || this.status === 'loading') return;
      // A managed reset targets zero; any other seek invalidates this pass.
      if (!this.internalSeek || Math.abs(video.currentTime) > 0.08) this.validCycle = false;
    });
    this.listen('seeked', () => { this.internalSeek = false; });
    this.listen('ended', () => { void this.handleEnded(); });
    this.listen('error', () => {
      if (this.isCurrent() && this.status !== 'loading') this.fail('この動画を再生できません。形式やファイルを確認してください。');
    });
    this.listen('waiting', () => {
      if (this.isCurrent() && this.wantsPlay && this.status !== 'loading') {
        this.status = 'buffering'; this.emit();
      }
    });
    this.listen('timeupdate', () => this.dispatchEvent(new Event('time')));
  }

  listen(name, fn) {
    this.video.addEventListener(name, fn);
    this.listeners.push([name, fn]);
  }
  isCurrent() { return Boolean(this.url && this.video.currentSrc === this.url); }
  get current() { return this.items.find(item => item.id === this.currentId) ?? null; }
  get index() { return this.items.findIndex(item => item.id === this.currentId); }
  emit() { this.dispatchEvent(new Event('change')); }

  async setPlaylist(items, preferredId = this.currentId) {
    this.items = items.slice();
    if (this.currentId && this.items.some(item => item.id === this.currentId)) {
      this.emit(); return;
    }
    const chosen = this.items.find(item => item.id === preferredId) ?? this.items[0];
    if (chosen) await this.select(chosen.id, false);
    else this.clear();
  }

  releaseSource() {
    this.cancelMetadata?.();
    this.cancelMetadata = null;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) this.urls.revokeObjectURL(this.url);
    this.url = null;
  }

  async select(id, autoplay = this.wantsPlay) {
    if (!this.items.some(item => item.id === id)) return;
    const token = ++this.serial;
    this.playSerial++;
    this.status = 'loading';
    this.wantsPlay = Boolean(autoplay);
    this.currentId = id;
    this.completed = 0;
    this.armed = false;
    this.validCycle = true;
    this.internalSeek = false;
    this.message = '';
    this.releaseSource();
    this.emit();
    try {
      const blob = await this.readBlob(id);
      if (token !== this.serial) return;
      if (!(blob instanceof Blob) || blob.size === 0) throw new Error('missing');
      this.url = this.urls.createObjectURL(blob);
      this.video.loop = this.mode === 'single';
      this.video.src = this.url;
      this.video.load();
      await this.waitForMetadata(token);
      if (token !== this.serial) return;
      if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) throw new Error('duration');
      this.status = 'paused';
      this.emit();
      if (this.wantsPlay) await this.play();
    } catch (error) {
      if (token !== this.serial) return;
      this.fail('動画の読み込みに失敗しました。再試行するか、次の動画へ進んでください。');
    }
  }

  waitForMetadata(token) {
    if (this.isCurrent() && this.video.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', loaded);
        this.video.removeEventListener('error', failed);
        if (this.cancelMetadata === cancelled) this.cancelMetadata = null;
      };
      const loaded = () => {
        if (token !== this.serial || !this.isCurrent()) return;
        cleanup(); resolve();
      };
      const failed = () => {
        if (token !== this.serial || !this.isCurrent() || !this.video.error) return;
        cleanup(); reject(new Error('media'));
      };
      const cancelled = () => { cleanup(); reject(new Error('cancelled')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 20000);
      this.cancelMetadata = cancelled;
      this.video.addEventListener('loadedmetadata', loaded);
      this.video.addEventListener('error', failed);
    });
  }

  async play() {
    if (!this.current || !this.url || this.status === 'loading') return;
    if (this.status === 'error') { await this.select(this.currentId, true); return; }
    if (this.video.ended) this.resetPass();
    this.wantsPlay = true;
    this.status = 'starting';
    this.emit();
    const token = this.serial;
    const attempt = ++this.playSerial;
    const pending = { token, attempt };
    this.pendingPlay = pending;
    try {
      await this.video.play();
      if (token !== this.serial || attempt !== this.playSerial) return;
      if (!this.wantsPlay) { this.video.pause(); return; }
      // play() resolves only once playback has started.
      this.armed = true;
      this.status = 'playing';
      this.message = '';
      this.emit();
    } catch (error) {
      if (token !== this.serial || attempt !== this.playSerial) return;
      if (!this.wantsPlay && error.name === 'AbortError') return;
      this.wantsPlay = false;
      this.armed = false;
      this.status = error.name === 'NotAllowedError' ? 'blocked' : 'error';
      this.message = error.name === 'NotAllowedError'
        ? '再生ボタンをタップすると、続きから再生できます。'
        : '再生を開始できませんでした。再試行するか、次の動画へ進んでください。';
      this.emit();
    } finally {
      if (this.pendingPlay === pending) this.pendingPlay = null;
    }
  }

  pause() {
    this.playSerial++;
    this.wantsPlay = false;
    this.video.pause();
    if (this.status !== 'empty' && this.status !== 'loading' && this.status !== 'error') this.status = 'paused';
    this.emit();
  }
  fail(message) {
    this.pause();
    this.armed = false;
    this.status = 'error';
    this.message = message;
    this.emit();
  }
  resetPass() {
    this.armed = false;
    this.validCycle = true;
    this.internalSeek = true;
    this.video.currentTime = 0;
  }
  async restart() {
    if (!this.url || this.status === 'loading') return;
    const resume = this.wantsPlay;
    this.completed = 0;
    this.video.pause();
    this.resetPass();
    this.wantsPlay = resume;
    if (resume) await this.play(); else { this.status = 'paused'; this.emit(); }
  }
  async configure(mode, count) {
    if (!['single', 'count'].includes(mode) || !validRepeatCount(count)) throw new Error('設定値が不正です。');
    const changed = this.mode !== mode || this.repeatCount !== Number(count);
    this.mode = mode;
    this.repeatCount = Number(count);
    this.video.loop = mode === 'single';
    if (changed) await this.restart();
    this.emit();
  }
  async move(delta) {
    if (!this.items.length) return;
    const next = (Math.max(0, this.index) + delta + this.items.length) % this.items.length;
    await this.select(this.items[next].id, this.wantsPlay);
  }
  async handleEnded() {
    if (!this.isCurrent() || !this.armed || !this.wantsPlay || !this.video.ended || this.status === 'loading') return;
    // Disarm before async work to consume this ending once.
    this.armed = false;
    if (this.mode === 'count' && this.validCycle) this.completed++;
    if (this.mode === 'count' && this.completed >= this.repeatCount) {
      await this.move(1);
    } else {
      this.resetPass();
      await this.play();
    }
  }
  clear() {
    this.serial++;
    this.playSerial++;
    this.status = 'empty';
    this.currentId = null;
    this.wantsPlay = false;
    this.completed = 0;
    this.armed = false;
    this.releaseSource();
    this.emit();
  }
  destroy() {
    this.clear();
    for (const [name, fn] of this.listeners) this.video.removeEventListener(name, fn);
  }
}
