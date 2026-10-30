import type { ThemeId } from '@gambit3d/shared';

/**
 * Web Audio engine.
 *
 * Sounds are synthesised at runtime rather than streamed from files. That keeps
 * the download small, lets each theme have a genuinely different voice from the
 * same code path, and means audio never fails because an asset 404'd. When a
 * licensed sample *is* available it is layered on top via `registerSample`.
 */

export type SfxName =
  | 'move'
  | 'capture'
  | 'castle'
  | 'check'
  | 'promote'
  | 'gameStart'
  | 'gameEnd'
  | 'lowTime'
  | 'notify'
  | 'select'
  | 'illegal'
  | 'uiClick';

export interface ThemeVoice {
  /** Base frequency in Hz for the primary tone. */
  root: number;
  /** Oscillator shape for the body of a move sound. */
  wave: OscillatorType;
  /** 0-1; how much noise transient is mixed in (wood knock vs pure tone). */
  transient: number;
  /** Reverb tail length in seconds. */
  space: number;
  /** Low-pass cutoff in Hz; lower = warmer/darker. */
  tone: number;
  /** Semitone offsets used when a sound needs a small chord. */
  chord: number[];
  /** Ambience layer description. */
  ambience: AmbienceSpec;
}

export interface AmbienceSpec {
  kind: 'wind' | 'rain' | 'hum';
  /** Base filter frequency for the noise bed. */
  cutoff: number;
  /** Slow LFO rate in Hz for movement in the bed. */
  drift: number;
  /** Optional drone frequencies. */
  drones: number[];
  gain: number;
}

/** Each map sounds different because it *is* a different synthesis voice. */
export const THEME_VOICES: Record<ThemeId, ThemeVoice> = {
  // Glass, rain and city bass. Bright transients, a short indoor tail.
  apartment: {
    root: 320,
    wave: 'sawtooth',
    transient: 0.2,
    space: 1.4,
    tone: 6800,
    chord: [0, 3, 7, 10],
    ambience: { kind: 'rain', cutoff: 2400, drift: 0.15, drones: [55, 82.5], gain: 0.2 },
  },
  // Metal and air handling. Soft transients, a long pressurised tail.
  station: {
    root: 392,
    wave: 'sine',
    transient: 0.08,
    space: 4.2,
    tone: 3200,
    chord: [0, 5, 7, 14],
    ambience: { kind: 'hum', cutoff: 380, drift: 0.03, drones: [49, 73.5, 98], gain: 0.14 },
  },
};

interface Levels {
  master: number;
  sfx: number;
  music: number;
  muted: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private ambienceNodes: AudioNode[] = [];
  private ambiencePlaying = false;

  private theme: ThemeId = 'apartment';
  private levels: Levels = { master: 0.7, sfx: 0.85, music: 0.35, muted: false };
  private samples = new Map<string, AudioBuffer>();
  private unlocked = false;
  private lastPlayAt = new Map<SfxName, number>();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Browsers refuse to start audio until a user gesture. Call this from a click
   * or key handler; it is safe to call repeatedly.
   */
  async unlock(): Promise<boolean> {
    try {
      if (!this.ctx) this.init();
      if (!this.ctx) return false;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.unlocked = this.ctx.state === 'running';
      return this.unlocked;
    } catch {
      return false;
    }
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  get available(): boolean {
    return typeof window !== 'undefined' && 'AudioContext' in window;
  }

  private init(): void {
    if (this.ctx) return;
    const Ctor =
      typeof window !== 'undefined'
        ? (window.AudioContext ??
          (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return;

    this.ctx = new Ctor();
    this.masterGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.reverbGain = this.ctx.createGain();
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.buildImpulse(THEME_VOICES[this.theme].space);

    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.reverbGain.connect(this.reverb);
    this.reverb.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    this.applyLevels();
  }

  setLevels(levels: Partial<Levels>): void {
    this.levels = { ...this.levels, ...levels };
    this.applyLevels();
  }

  private applyLevels(): void {
    if (!this.ctx || !this.masterGain || !this.sfxGain || !this.musicGain) return;
    const t = this.ctx.currentTime;
    const master = this.levels.muted ? 0 : clamp01(this.levels.master);
    this.masterGain.gain.setTargetAtTime(master, t, 0.03);
    this.sfxGain.gain.setTargetAtTime(clamp01(this.levels.sfx), t, 0.03);
    this.musicGain.gain.setTargetAtTime(clamp01(this.levels.music), t, 0.08);
  }

  setTheme(theme: ThemeId): void {
    if (this.theme === theme) return;
    this.theme = theme;
    if (this.ctx && this.reverb) {
      this.reverb.buffer = this.buildImpulse(THEME_VOICES[theme].space);
    }
    if (this.ambiencePlaying) {
      this.stopAmbience();
      this.startAmbience();
    }
  }

  get currentTheme(): ThemeId {
    return this.theme;
  }

  /** Registers a decoded sample to layer under a synthesised cue. */
  registerSample(name: string, buffer: AudioBuffer): void {
    this.samples.set(name, buffer);
  }

  async loadSample(name: string, url: string): Promise<boolean> {
    try {
      if (!this.ctx) this.init();
      if (!this.ctx) return false;
      const response = await fetch(url);
      if (!response.ok) return false;
      const data = await response.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(data);
      this.samples.set(name, buffer);
      return true;
    } catch {
      // A missing or undecodable sample is not fatal - the synth voice covers it.
      return false;
    }
  }

  dispose(): void {
    this.stopAmbience();
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.masterGain = null;
    this.unlocked = false;
  }

  // -------------------------------------------------------------------------
  // Reverb impulse
  // -------------------------------------------------------------------------

  private buildImpulse(seconds: number): AudioBuffer | null {
    if (!this.ctx) return null;
    const rate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        const decay = (1 - i / length) ** 2.4;
        data[i] = (Math.random() * 2 - 1) * decay;
      }
    }
    return impulse;
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  play(name: SfxName, options: { volume?: number; throttleMs?: number } = {}): void {
    if (!this.unlocked || this.levels.muted) return;
    if (!this.ctx || !this.sfxGain) return;

    const throttle = options.throttleMs ?? 40;
    const now = performance.now();
    const last = this.lastPlayAt.get(name) ?? 0;
    if (now - last < throttle) return;
    this.lastPlayAt.set(name, now);

    const sample = this.samples.get(`${this.theme}:${name}`) ?? this.samples.get(name);
    if (sample) {
      this.playBuffer(sample, options.volume ?? 1);
      return;
    }
    this.synthesise(name, options.volume ?? 1);
  }

  private playBuffer(buffer: AudioBuffer, volume: number): void {
    if (!this.ctx || !this.sfxGain) return;
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = clamp01(volume);
    source.connect(gain).connect(this.sfxGain);
    source.start();
  }

  /** Builds each cue from oscillators + filtered noise, coloured by the theme. */
  private synthesise(name: SfxName, volume: number): void {
    const ctx = this.ctx;
    const out = this.sfxGain;
    if (!ctx || !out) return;

    const voice = THEME_VOICES[this.theme];
    const t0 = ctx.currentTime;

    const spec = CUES[name];
    const root = voice.root * spec.pitch;

    const bus = ctx.createGain();
    bus.gain.value = clamp01(volume * spec.gain);
    bus.connect(out);
    if (this.reverbGain && spec.wet > 0) {
      const send = ctx.createGain();
      send.gain.value = spec.wet;
      bus.connect(send).connect(this.reverbGain);
    }

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(voice.tone * spec.brightness, t0);
    filter.Q.value = spec.resonance;
    filter.connect(bus);

    // Tonal body
    for (const [index, semitone] of spec.intervals.entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = spec.wave ?? voice.wave;

      const freq = root * 2 ** ((voice.chord[semitone] ?? semitone * 2) / 12);
      osc.frequency.setValueAtTime(freq, t0);
      if (spec.sweep !== 0) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(30, freq * (1 + spec.sweep)),
          t0 + spec.decay * 0.8,
        );
      }

      const peak = 0.32 / (index + 1);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + spec.attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.attack + spec.decay);

      osc.connect(gain).connect(filter);
      osc.start(t0);
      osc.stop(t0 + spec.attack + spec.decay + 0.05);
    }

    // Noise transient - the "knock" of a piece landing.
    const transientAmount = spec.transient * voice.transient;
    if (transientAmount > 0.001) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer(0.12);
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = 1400 * spec.brightness;
      noiseFilter.Q.value = 0.8;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(transientAmount * 0.6, t0);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
      noise.connect(noiseFilter).connect(noiseGain).connect(bus);
      noise.start(t0);
      noise.stop(t0 + 0.14);
    }
  }

  private noiseCache: AudioBuffer | null = null;

  private noiseBuffer(seconds: number): AudioBuffer | null {
    if (!this.ctx) return null;
    if (this.noiseCache && this.noiseCache.duration >= seconds) return this.noiseCache;
    const length = Math.floor(this.ctx.sampleRate * Math.max(seconds, 1));
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    this.noiseCache = buffer;
    return buffer;
  }

  // -------------------------------------------------------------------------
  // Ambience
  // -------------------------------------------------------------------------

  startAmbience(): void {
    if (!this.unlocked || this.ambiencePlaying) return;
    const ctx = this.ctx;
    const out = this.musicGain;
    if (!ctx || !out) return;

    const spec = THEME_VOICES[this.theme].ambience;
    const t0 = ctx.currentTime;
    const nodes: AudioNode[] = [];

    // Filtered noise bed: wind, rain or station hum depending on the theme.
    const noise = ctx.createBufferSource();
    const buffer = this.noiseBuffer(4);
    if (buffer) {
      noise.buffer = buffer;
      noise.loop = true;

      const bedFilter = ctx.createBiquadFilter();
      bedFilter.type = spec.kind === 'rain' ? 'highpass' : 'lowpass';
      bedFilter.frequency.value = spec.cutoff;
      bedFilter.Q.value = spec.kind === 'hum' ? 6 : 0.7;

      const bedGain = ctx.createGain();
      bedGain.gain.setValueAtTime(0, t0);
      bedGain.gain.linearRampToValueAtTime(spec.gain, t0 + 2.5);

      // Slow drift so the bed never sits perfectly still.
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = spec.drift;
      lfoGain.gain.value = spec.cutoff * 0.35;
      lfo.connect(lfoGain).connect(bedFilter.frequency);
      lfo.start(t0);

      noise.connect(bedFilter).connect(bedGain).connect(out);
      noise.start(t0);
      nodes.push(noise, lfo, bedGain, bedFilter, lfoGain);
    }

    // Sustained drones give each map its harmonic identity.
    for (const [index, freq] of spec.drones.entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = index % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(spec.gain * 0.4 * (1 / (index + 1)), t0 + 4);

      // Gentle detune movement.
      const vib = ctx.createOscillator();
      const vibGain = ctx.createGain();
      vib.frequency.value = 0.07 + index * 0.02;
      vibGain.gain.value = freq * 0.004;
      vib.connect(vibGain).connect(osc.frequency);
      vib.start(t0);

      osc.connect(gain).connect(out);
      osc.start(t0);
      nodes.push(osc, vib, gain, vibGain);
    }

    this.ambienceNodes = nodes;
    this.ambiencePlaying = true;
  }

  stopAmbience(): void {
    if (!this.ambiencePlaying) return;
    for (const node of this.ambienceNodes) {
      try {
        if ('stop' in node && typeof (node as OscillatorNode).stop === 'function') {
          (node as OscillatorNode).stop();
        }
        node.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.ambienceNodes = [];
    this.ambiencePlaying = false;
  }

  get ambienceActive(): boolean {
    return this.ambiencePlaying;
  }
}

interface CueSpec {
  /** Multiplier on the theme's root frequency. */
  pitch: number;
  intervals: number[];
  attack: number;
  decay: number;
  gain: number;
  /** Multiplier on the theme's low-pass cutoff. */
  brightness: number;
  resonance: number;
  transient: number;
  /** Reverb send amount, 0-1. */
  wet: number;
  /** Relative pitch sweep over the decay; negative falls. */
  sweep: number;
  wave?: OscillatorType;
}

const CUES: Record<SfxName, CueSpec> = {
  move: { pitch: 0.5, intervals: [0], attack: 0.004, decay: 0.16, gain: 0.55, brightness: 0.8, resonance: 1, transient: 1, wet: 0.18, sweep: -0.08 },
  capture: { pitch: 0.38, intervals: [0, 1], attack: 0.003, decay: 0.3, gain: 0.75, brightness: 1.1, resonance: 2.2, transient: 1.4, wet: 0.3, sweep: -0.22 },
  castle: { pitch: 0.45, intervals: [0, 2], attack: 0.006, decay: 0.34, gain: 0.6, brightness: 0.85, resonance: 1.2, transient: 1.1, wet: 0.28, sweep: -0.05 },
  check: { pitch: 1.5, intervals: [0, 3], attack: 0.004, decay: 0.42, gain: 0.7, brightness: 1.5, resonance: 3, transient: 0.4, wet: 0.4, sweep: 0.1 },
  promote: { pitch: 1, intervals: [0, 2, 3], attack: 0.01, decay: 0.7, gain: 0.7, brightness: 1.3, resonance: 1.5, transient: 0.3, wet: 0.5, sweep: 0.25 },
  gameStart: { pitch: 0.75, intervals: [0, 2, 3], attack: 0.02, decay: 0.9, gain: 0.6, brightness: 1.1, resonance: 1, transient: 0.2, wet: 0.55, sweep: 0.12 },
  gameEnd: { pitch: 0.5, intervals: [0, 1, 3], attack: 0.02, decay: 1.4, gain: 0.6, brightness: 0.7, resonance: 1, transient: 0.2, wet: 0.6, sweep: -0.3 },
  lowTime: { pitch: 2, intervals: [0], attack: 0.002, decay: 0.1, gain: 0.5, brightness: 1.8, resonance: 4, transient: 0.1, wet: 0.1, sweep: 0, wave: 'square' },
  notify: { pitch: 1.25, intervals: [0, 2], attack: 0.005, decay: 0.25, gain: 0.4, brightness: 1.4, resonance: 1.5, transient: 0.2, wet: 0.25, sweep: 0.08 },
  select: { pitch: 1.5, intervals: [0], attack: 0.002, decay: 0.06, gain: 0.28, brightness: 1.6, resonance: 1, transient: 0.3, wet: 0.08, sweep: 0 },
  illegal: { pitch: 0.35, intervals: [0, 1], attack: 0.002, decay: 0.18, gain: 0.5, brightness: 0.6, resonance: 5, transient: 0.6, wet: 0.1, sweep: -0.35, wave: 'square' },
  uiClick: { pitch: 1.75, intervals: [0], attack: 0.001, decay: 0.045, gain: 0.22, brightness: 1.9, resonance: 1, transient: 0.5, wet: 0.05, sweep: 0 },
};

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Process-wide singleton; the app owns exactly one AudioContext. */
export const audio = new AudioEngine();
