/** Tiny synthesized SFX via WebAudio — no asset files. All calls no-op unless enabled. */

let ctx: AudioContext | null = null;
let enabled = false;

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (on && !ctx) ctx = new AudioContext();
  if (on) void ctx?.resume();
}

function tone(freq: number, duration: number, type: OscillatorType, gainPeak: number, when = 0): void {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(gainPeak, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.05);
}

function noise(duration: number, gainPeak: number, filterFreq: number, when = 0): void {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime + when;
  const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainPeak, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
}

/** Paper slide on draw/reorder. */
export const sfxDraw = () => noise(0.12, 0.06, 2400);

/** Warm chime on a successful play. */
export const sfxPlay = () => {
  tone(660, 0.35, 'sine', 0.12);
  tone(990, 0.45, 'sine', 0.07, 0.06);
};

/** Distant firework on completing a stack. */
export const sfxFirework = () => {
  tone(70, 0.5, 'sine', 0.18);
  noise(0.7, 0.08, 1200, 0.12);
  tone(1320, 0.6, 'sine', 0.04, 0.18);
};

/** Fuse sizzle on a misplay. */
export const sfxSizzle = () => {
  noise(0.55, 0.1, 600);
  tone(110, 0.4, 'sawtooth', 0.05, 0.05);
};

/** Soft ding when it becomes your turn. */
export const sfxTurn = () => tone(880, 0.25, 'triangle', 0.08);

/** Clue shimmer. */
export const sfxClue = () => {
  tone(523, 0.18, 'sine', 0.07);
  tone(784, 0.22, 'sine', 0.06, 0.07);
};
