/**
 * audio.js — procedural WebAudio: every sound is synthesized, no assets.
 *
 * Structure:
 *   master -> limiter -> destination
 *     sfx   ->|
 *     music ->|  (music has its own lowpass that follows the combo intensity,
 *                 which is why the soundtrack "opens up" as you chain bricks)
 *
 * All game sounds are short one-shot voices built from oscillators and one
 * shared white-noise buffer, so the whole soundtrack costs ~10 KB of code
 * instead of a folder of .mp3s.
 */
import { clamp } from './math.js';

// A minor pentatonic ladder: brick N plays the Nth note, so a long chain
// literally plays a tune that climbs an octave and a half.
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27];

export class GameAudio {
  constructor() {
    this.ok = false;
    this.muted = false;
    this.intensity = 0;   // 0..1, driven by the combo, opens the music filter
    this.level = 1;
    this.flipActive = false;
    this.musicVolume = 0.5;
    this.sfxVolume = 0.85;
  }

  /** Must be called from a user gesture (browsers require it). */
  unlock() {
    if (this.ok) { this.resume(); return; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = this.ctx = new AC({ latencyHint: 'interactive' });

      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -9;
      this.limiter.knee.value = 8;
      this.limiter.ratio.value = 7;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.2;

      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.limiter);
      this.limiter.connect(ctx.destination);

      // --- sfx bus with a stereo-ish spread and a shared delay send
      this.sfx = ctx.createGain();
      this.sfx.gain.value = this.sfxVolume;
      this.sfx.connect(this.master);

      this.space = ctx.createDelay(0.5);
      this.space.delayTime.value = 0.135;
      this.spaceFb = ctx.createGain();
      this.spaceFb.gain.value = 0.26;
      this.spaceTone = ctx.createBiquadFilter();
      this.spaceTone.type = 'lowpass';
      this.spaceTone.frequency.value = 2600;
      this.spaceSend = ctx.createGain();
      this.spaceSend.gain.value = 0.5;
      this.spaceSend.connect(this.space);
      this.space.connect(this.spaceTone);
      this.spaceTone.connect(this.spaceFb);
      this.spaceFb.connect(this.space);
      this.spaceTone.connect(this.master);

      // --- music bus: lowpass + duck gain
      this.music = ctx.createGain();
      this.music.gain.value = this.musicVolume;
      this.musicFilter = ctx.createBiquadFilter();
      this.musicFilter.type = 'lowpass';
      this.musicFilter.frequency.value = 900;
      this.musicFilter.Q.value = 0.6;
      this.music.connect(this.musicFilter);
      this.musicFilter.connect(this.master);

      this.musicDuck = this.music.gain;

      // shared noise source buffer
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      this.ok = true;
      this.resume();
      this._startMusic();
    } catch (e) {
      this.ok = false;
    }
  }

  resume() {
    if (this.ok && this.ctx.state === 'suspended') this.ctx.resume();
  }

  get t() { return this.ctx.currentTime; }

  // ================================================================ voices ===

  /** Oscillator voice with an exponential pitch + amplitude envelope. */
  _tone(o) {
    const ctx = this.ctx, t = o.at ?? this.t + 0.001;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(20, o.freq), t);
    if (o.freqTo) {
      if (o.linear) osc.frequency.linearRampToValueAtTime(o.freqTo, t + o.dur);
      else osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqTo), t + o.dur);
    }

    let node = osc;
    if (o.filter) {
      const f = ctx.createBiquadFilter();
      f.type = o.filter;
      f.frequency.setValueAtTime(o.filterFreq ?? 2000, t);
      if (o.filterTo) f.frequency.exponentialRampToValueAtTime(o.filterTo, t + o.dur);
      f.Q.value = o.q ?? 1;
      node.connect(f); node = f;
    }

    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    const atk = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    node.connect(g);
    this._out(g, o);
    osc.start(t);
    osc.stop(t + o.dur + 0.02);
  }

  /** Filtered noise burst — impacts, hats, explosions, wind. */
  _noise(o) {
    const ctx = this.ctx, t = o.at ?? this.t + 0.001;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;

    const f = ctx.createBiquadFilter();
    f.type = o.filter ?? 'bandpass';
    f.frequency.setValueAtTime(o.freq ?? 1200, t);
    if (o.freqTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, o.freqTo), t + o.dur);
    f.Q.value = o.q ?? 1.2;

    let node = src;
    if (o.shaper) {
      const ws = ctx.createWaveShaper();
      ws.curve = o.shaper;
      node.connect(ws); node = ws;
    }
    const g = ctx.createGain();
    const peak = o.gain ?? 0.2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + (o.attack ?? 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    node.connect(f);
    f.connect(g);
    this._out(g, o);
    src.start(t);
    src.stop(t + o.dur + 0.02);
  }

  /** Route a voice into the sfx bus with an optional pan + delay send. */
  _out(node, o) {
    const ctx = this.ctx;
    let tail = node;
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      node.connect(p);
      tail = p;
    }
    tail.connect(o.music ? this.music : this.sfx);
    if (o.send) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      tail.connect(s);
      s.connect(this.spaceSend);
    }
  }

  _distCurve(amount = 8) {
    if (this._curve && this._curveAmount === amount) return this._curve;
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    this._curveAmount = amount;
    return (this._curve = curve);
  }

  // ================================================================== sfx ====

  /** Brick break: pentatonic ladder + a bright click. `kind` tints it. */
  brick(step, pan, kind = 'basic') {
    if (!this.ok) return;
    const semi = PENTA[Math.min(step, PENTA.length - 1)];
    const base = kind === 'armored' ? 480 : 660;
    const freq = base * 2 ** (semi / 12);
    const dur = kind === 'armored' ? 0.16 : 0.13;
    this._tone({ freq, freqTo: freq * 0.98, type: kind === 'armored' ? 'square' : 'triangle',
      dur, gain: kind === 'armored' ? 0.11 : 0.14, pan, filter: 'lowpass', filterFreq: 5200, send: 0.05 });
    this._tone({ freq: freq * 2, type: 'sine', dur: dur * 0.5, gain: 0.05, pan, attack: 0.001 });
    this._noise({ freq: 3400, freqTo: 1400, dur: 0.05, gain: 0.05, q: 0.9, pan, filter: 'highpass' });
  }

  /** Paddle bounce: pitch follows how fast the ball was going. */
  paddle(offset, speed) {
    if (!this.ok) return;
    const f = 150 + clamp(speed / 1400, 0, 1) * 90;
    this._tone({ freq: f, freqTo: f * 0.45, type: 'sine', dur: 0.14, gain: 0.28, pan: offset });
    this._tone({ freq: f * 2.02, freqTo: f * 1.1, type: 'triangle', dur: 0.07, gain: 0.09, pan: offset });
    this._noise({ freq: 900, freqTo: 260, dur: 0.06, gain: 0.08, q: 0.8, pan: offset });
  }

  wall(speed, pan) {
    if (!this.ok) return;
    const v = clamp(speed / 1400, 0.15, 1);
    this._tone({ freq: 220, freqTo: 150, type: 'sine', dur: 0.07, gain: 0.06 * v, pan });
    this._noise({ freq: 2600, freqTo: 900, dur: 0.045, gain: 0.05 * v, q: 1.4, pan, filter: 'highpass' });
  }

  launch() {
    if (!this.ok) return;
    this._tone({ freq: 320, freqTo: 900, type: 'triangle', dur: 0.16, gain: 0.14, linear: true });
    this._noise({ freq: 700, freqTo: 3600, dur: 0.16, gain: 0.06, q: 0.7 });
  }

  /** Gravity flip: a warp riser, a sub drop, and a delayed bell at the top. */
  flip() {
    if (!this.ok) return;
    this._noise({ freq: 240, freqTo: 6200, dur: 0.42, gain: 0.16, q: 0.7, filter: 'bandpass' });
    this._tone({ freq: 160, freqTo: 720, type: 'sawtooth', dur: 0.4, gain: 0.1,
      filter: 'lowpass', filterFreq: 400, filterTo: 4200, q: 4 });
    this._tone({ freq: 110, freqTo: 46, type: 'sine', dur: 0.5, gain: 0.24 });
    this._tone({ freq: 1320, freqTo: 1318, type: 'sine', dur: 0.7, gain: 0.07, send: 0.3, at: this.t + 0.34 });
  }

  /** Gravity landing: the "clunk" as the flip expires and gravity returns. */
  flipLand() {
    if (!this.ok) return;
    this._tone({ freq: 120, freqTo: 52, type: 'sine', dur: 0.2, gain: 0.16 });
    this._noise({ freq: 500, freqTo: 120, dur: 0.14, gain: 0.07, q: 0.6, filter: 'lowpass' });
  }

  explode(pan, power = 1) {
    if (!this.ok) return;
    const shaper = this._distCurve(12);
    this._noise({ freq: 1800 * power, freqTo: 90, dur: 0.55 * power, gain: 0.3, q: 0.5,
      filter: 'lowpass', pan, shaper });
    this._tone({ freq: 170, freqTo: 34, type: 'sine', dur: 0.5, gain: 0.3, pan });
    this._tone({ freq: 96, freqTo: 30, type: 'triangle', dur: 0.36, gain: 0.18, pan });
  }

  /** Shield brick deflect: metallic ping, deliberately annoying (in a good way). */
  shield(pan, pitch = 1) {
    if (!this.ok) return;
    this._tone({ freq: 1500 * pitch, type: 'square', dur: 0.13, gain: 0.055, pan,
      filter: 'highpass', filterFreq: 900 });
    this._tone({ freq: 2270 * pitch, type: 'square', dur: 0.09, gain: 0.035, pan });
    this._noise({ freq: 4200, dur: 0.07, gain: 0.045, q: 2, pan, filter: 'bandpass' });
  }

  powerup(kind, pan = 0) {
    if (!this.ok) return;
    const seq = kind === 'multi' ? [523, 659, 784, 1047]
      : kind === 'grav' ? [392, 466, 622, 932]
        : [440, 660];
    seq.forEach((f, i) => {
      this._tone({ freq: f, type: 'triangle', dur: 0.16, gain: 0.1, pan, send: 0.12, at: this.t + i * 0.055 });
    });
  }

  /** Chain step tick: rises with the multiplier, so combos sound like a run. */
  combo(step) {
    if (!this.ok) return;
    const f = 880 * 2 ** (Math.min(step, 14) * 0.5 / 12);
    this._tone({ freq: f, freqTo: f * 1.5, type: 'sine', dur: 0.09, gain: 0.05, linear: true });
  }

  life() {
    if (!this.ok) return;
    this._noise({ freq: 2600, freqTo: 90, dur: 0.7, gain: 0.22, q: 0.7, filter: 'lowpass', shaper: this._distCurve(6) });
    this._tone({ freq: 320, freqTo: 90, type: 'sawtooth', dur: 0.6, gain: 0.12, filter: 'lowpass', filterFreq: 1400, filterTo: 200 });
    this._tone({ freq: 160, freqTo: 60, type: 'sine', dur: 0.5, gain: 0.2 });
    this.duck(0.35, 1.1);
  }

  clear() {
    if (!this.ok) return;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      this._tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.1, send: 0.3, at: this.t + i * 0.09 });
      this._tone({ freq: f * 2, type: 'sine', dur: 0.3, gain: 0.04, at: this.t + i * 0.09 });
    });
    this._tone({ freq: 130, freqTo: 65, type: 'sine', dur: 0.9, gain: 0.2 });
  }

  extraLife() {
    if (!this.ok) return;
    [784, 1046, 1318, 1568, 2093].forEach((f, i) => {
      this._tone({ freq: f, type: 'sine', dur: 0.45, gain: 0.09, send: 0.35, at: this.t + i * 0.07 });
    });
  }

  gameOver() {
    if (!this.ok) return;
    [[220, 0], [174.6, 0.28], [146.8, 0.56], [110, 0.86]].forEach(([f, dt]) => {
      this._tone({ freq: f, type: 'triangle', dur: 0.9, gain: 0.16, send: 0.25, at: this.t + dt });
      this._tone({ freq: f / 2, type: 'sine', dur: 1.1, gain: 0.12, at: this.t + dt });
    });
    this.duck(0.7, 2.4);
  }

  ui(kind = 'move') {
    if (!this.ok) return;
    if (kind === 'select') {
      this._tone({ freq: 660, freqTo: 1320, type: 'triangle', dur: 0.14, gain: 0.1, linear: true });
      this._noise({ freq: 3000, freqTo: 6000, dur: 0.1, gain: 0.03, q: 1 });
    } else {
      this._tone({ freq: 520, type: 'triangle', dur: 0.05, gain: 0.035 });
    }
  }

  ballTick() {
    if (!this.ok) return;
    this._tone({ freq: 1400, type: 'sine', dur: 0.03, gain: 0.02 });
  }

  // ================================================================ music ===

  _startMusic() {
    // A minor pentatonic loop: kick / hat / bass / arp on a 16-step grid.
    this.beat = 0;
    this.nextBeatTime = this.t + 0.15;
    this.bassLine = [55, 55, 65.4, 49, 55, 55, 73.4, 65.4];   // A F C G roots
    this.bpm = 100;
    if (!this._timer) {
      this._timer = setInterval(() => this._schedule(), 40);
    }
    this._schedule();
  }

  _schedule() {
    if (!this.ok || this.muted) return;
    const ahead = 0.3;
    let guard = 32;
    while (this.nextBeatTime < this.t + ahead && guard-- > 0) {
      this._playStep(this.beat, this.nextBeatTime);
      this.beat++;
      this.nextBeatTime += 60 / this._currentBpm() / 2;   // eighth notes
    }
    if (this.nextBeatTime < this.t) this.nextBeatTime = this.t + 0.05;
  }

  _currentBpm() {
    const base = 100 + Math.min(this.level - 1, 8) * 3;
    return base * (1 + this.intensity * 0.06) * (this.flipActive ? 1.06 : 1);
  }

  setLevel(n) { this.level = n; }

  setIntensity(v) {
    this.intensity = clamp(v, 0, 1);
    if (!this.ok) return;
    const target = 700 + this.intensity * 3200 + (this.flipActive ? 1600 : 0);
    this.musicFilter.frequency.setTargetAtTime(target, this.t, 0.25);
  }

  setFlipActive(on) {
    this.flipActive = on;
    if (this.ok) this.setIntensity(this.intensity);
  }

  duck(amount, time) {
    if (!this.ok) return;
    const g = this.music.gain, t = this.t;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.musicVolume * (1 - amount), t + 0.04);
    g.linearRampToValueAtTime(this.musicVolume, t + time);
  }

  _playStep(beat, t) {
    const step = beat % 16;
    const bar = ((beat / 16) | 0) % 4;

    // --- kick
    if (step % 4 === 0 || (this.intensity > 0.3 && step === 14)) {
      this._tone({ freq: 130, freqTo: 44, type: 'sine', dur: 0.19, gain: 0.5, at: t, music: true });
      this._noise({ freq: 900, freqTo: 60, dur: 0.05, gain: 0.16, at: t, q: 0.6, filter: 'lowpass', music: true });
    }
    // --- hats
    if (step % 2 === 1) {
      this._noise({ freq: 7000, freqTo: 4000, dur: 0.03, gain: 0.045 + (step % 4 === 3 ? 0.03 : 0), q: 1.2,
        filter: 'highpass', at: t, music: true });
    }
    // --- snare on 3 when the level gets spicy
    if (this.level >= 3 && (step === 4 || step === 12)) {
      this._noise({ freq: 1900, dur: 0.13, gain: 0.11, q: 0.9, at: t, filter: 'bandpass', music: true });
    }
    // --- bass
    if (step % 4 === 0) {
      const root = this.bassLine[bar];
      this._tone({ freq: root, type: 'sawtooth', dur: 0.36, gain: 0.16, at: t,
        filter: 'lowpass', filterFreq: 300 + this.intensity * 900, q: 3, music: true });
      if (this.intensity > 0.2) {
        this._tone({ freq: root * 2, type: 'square', dur: 0.18, gain: 0.05, at: t, music: true });
      }
    }
    // --- arp: the payoff for holding a combo (it only exists when you're hot)
    if (this.intensity > 0.12) {
      const scale = [440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.7];
      const pattern = [0, 2, 4, 3, 5, 4, 2, 6, 0, 3, 5, 2, 4, 6, 3, 7];
      const f = scale[pattern[step]] * (bar === 2 ? 2 : 1);
      this._tone({ freq: f, type: 'triangle', dur: 0.22, gain: 0.05 + this.intensity * 0.06,
        at: t, send: 0.35, music: true });
    }
  }
}
