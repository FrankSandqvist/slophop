"use client";

/** One shared AudioContext for the beat and UI blips. Starts on the first user gesture. */
let context: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

function audio() {
  if (typeof window === "undefined") return null;
  // Browsers refuse audio before the first tap/click; stay silent until then instead of warning.
  if (!context && navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
    master = context.createGain();
    master.connect(context.destination);
  }
  if (context.state === "suspended") void context.resume();
  return context;
}

export function setMuted(value: boolean) {
  muted = value;
  if (master && context) master.gain.setTargetAtTime(value ? 0 : 1, context.currentTime, 0.05);
}

export function isMuted() {
  return muted;
}

function tone(type: OscillatorType, from: number, to: number, duration: number, volume: number, delay = 0) {
  const ctx = audio();
  if (!ctx || !master || muted) return;
  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(master);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** Small chiptune-ish blips for the UI. */
export const sfx = {
  select: () => tone("square", 880, 880, 0.05, 0.05),
  cycle: () => tone("square", 660, 990, 0.06, 0.045),
  text: () => tone("square", 1200 + Math.random() * 200, 1200, 0.025, 0.018),
  right: () => {
    tone("square", 784, 784, 0.08, 0.05);
    tone("square", 1047, 1047, 0.08, 0.05, 0.08);
    tone("square", 1568, 1568, 0.16, 0.05, 0.16);
  },
  wrong: () => tone("sawtooth", 200, 120, 0.25, 0.05),
  /** A chiptune snare roll that speeds up for ~2s (the winner reveal). */
  drumroll: () => {
    let at = 0;
    for (let i = 0; i < 26; i++) {
      tone("square", 150 + i * 3, 120, 0.035, 0.03 + i * 0.0012, at);
      at += Math.max(0.045, 0.12 - i * 0.004);
    }
  },
  found: () => {
    for (const [index, note] of [523, 659, 784, 1047, 1319].entries()) tone("triangle", note, note, 0.12, 0.06, index * 0.06);
  },
};

/* ---------- Voices: Animal Crossing-style babble, one syllable per letter ---------- */

const VOWELS: Record<string, [number, number]> = { a: [800, 1200], e: [500, 1900], i: [320, 2300], o: [500, 900], u: [350, 800], y: [320, 2300] };
/** Pentatonic steps, so a line of babble sounds sung rather than random. */
const STEPS = [0, 2, 4, 7, 9, 12];
const VOICES = {
  add: { base: 440, wave: "square" as OscillatorType, glide: 1.12, cutoff: 3200, volume: 0.2 },
  del: { base: 200, wave: "sawtooth" as OscillatorType, glide: 0.9, cutoff: 1300, volume: 0.28 },
};

/** One babbled syllable for `char`. Green chirps high and bright; Red grumbles low. `rise` lifts the pitch (questions). */
export function voice(who: "add" | "del", char: string, rise = 0) {
  const ctx = audio();
  if (!ctx || !master || muted) return;
  const letter = char.toLowerCase();
  if (!/[a-z0-9]/.test(letter)) return;
  const settings = VOICES[who];
  const step = STEPS[(letter.charCodeAt(0) * 7) % STEPS.length];
  const pitch = settings.base * Math.pow(2, (step + rise) / 12) * (0.97 + Math.random() * 0.06);
  const vowel = VOWELS[letter];
  const duration = vowel ? 0.075 : 0.05;
  const start = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = settings.wave;
  osc.frequency.setValueAtTime(pitch, start);
  osc.frequency.exponentialRampToValueAtTime(pitch * settings.glide, start + duration);
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = settings.cutoff;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(settings.volume, start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(tone);
  // Vowels get two formant peaks, so "a" and "i" sound different; consonants stay a plain blip.
  if (vowel) {
    for (const frequency of vowel) {
      const formant = ctx.createBiquadFilter();
      formant.type = "bandpass";
      formant.frequency.value = frequency * (who === "add" ? 1.15 : 0.85);
      formant.Q.value = 5;
      tone.connect(formant).connect(gain);
    }
    const body = ctx.createGain();
    body.gain.value = 0.6;
    tone.connect(body).connect(gain);
  } else {
    tone.connect(gain);
  }
  gain.connect(master);
  osc.start(start);
  osc.stop(start + duration + 0.02);
  duck(ctx);
}

/** Lowers the music while someone talks, and lets it swell back shortly after they stop. */
function duck(ctx: AudioContext) {
  if (!playing) return;
  const level = playing.gain.gain;
  const now = ctx.currentTime;
  level.cancelScheduledValues(now);
  level.setTargetAtTime(MUSIC_DUCKED, now, 0.03);
  level.setTargetAtTime(MUSIC_LEVEL, now + 0.25, 0.25);
}

/* ---------- Music: a gapless loop, plus its beat so the mascots can dance to it ---------- */

let playing: { source: AudioBufferSourceNode; gain: GainNode; startAt: number; duration: number; bpm: number } | null = null;
const MUSIC_LEVEL = 0.45;
const MUSIC_DUCKED = 0.15;

/**
 * Makes a clip loop without a gap or click: trims the silence MP3s carry at both ends (encoder padding) and any fade-out
 * Lyria adds anyway, cuts it to whole bars at the tempo Lyria was asked for (so the loop point lands on the beat), then
 * folds the last few milliseconds over the start (an equal-power crossfade), so the end runs straight into the beginning.
 */
function loopable(ctx: AudioContext, buffer: AudioBuffer, bpm: number) {
  const rate = buffer.sampleRate;
  const window = Math.round(rate * 0.05);
  const windows = Math.floor(buffer.length / window);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const loudness = Array.from({ length: windows }, (_, w) => {
    let sum = 0;
    for (const channel of channels) for (let i = w * window; i < (w + 1) * window; i++) sum += channel[i] * channel[i];
    return Math.sqrt(sum / (window * channels.length));
  });
  const typical = [...loudness].sort((a, b) => a - b)[Math.floor(windows / 2)] ?? 0;
  if (!typical || windows < 40) return buffer;
  // Start at the first sound; end where it is still at least half as loud as usual (cuts a fade-out tail).
  const first = Math.max(0, loudness.findIndex((value) => value > typical * 0.1));
  let last = windows - 1;
  while (last > first + 20 && loudness[last] < typical * 0.5) last--;
  const start = first * window;
  let end = Math.min(buffer.length, (last + 1) * window);
  const fade = Math.min(Math.round(rate * 0.03), Math.floor((end - start) / 4));
  const bar = (4 * 60 * rate) / bpm;
  const bars = Math.floor((end - start - fade) / bar);
  if (bars >= 4) end = start + Math.round(bars * bar) + fade;
  const length = end - start - fade;
  const out = ctx.createBuffer(channels.length, length, rate);
  channels.forEach((channel, index) => {
    const data = out.getChannelData(index);
    data.set(channel.subarray(start, start + length));
    for (let i = 0; i < fade; i++) {
      const x = i / fade;
      data[i] = channel[start + i] * Math.sin((x * Math.PI) / 2) + channel[end - fade + i] * Math.cos((x * Math.PI) / 2);
    }
  });
  return out;
}

/** Where the playing music is, in beats (whole numbers land on the kick), or null when nothing plays. */
export function musicBeat(): { bpm: number; beat: number } | null {
  if (!playing || !context) return null;
  const position = (context.currentTime - playing.startAt) % playing.duration;
  if (position < 0) return null;
  return { bpm: playing.bpm, beat: (position * playing.bpm) / 60 };
}

/**
 * Returns null when it can't play (no tap yet, or no track).
 * Loops a soundtrack gaplessly and keeps a beat clock from its start (restarting each loop) at `bpm`, the tempo Lyria was
 * asked for. Lyria takes tempo as a prompt hint, so it's approximate.
 */
export async function playLoop(url: string, bpm = 96): Promise<(() => void) | null> {
  const ctx = audio();
  if (!ctx || !master) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const buffer = loopable(ctx, await ctx.decodeAudioData(await response.arrayBuffer()), bpm);
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  source.loop = true;
  const startAt = ctx.currentTime + 0.05;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(MUSIC_LEVEL, startAt + 1.5);
  source.connect(gain).connect(master);
  source.start(startAt);
  playing?.source.stop();
  playing = { source, gain, startAt, duration: buffer.duration, bpm };
  return () => {
    try {
      source.stop();
    } catch {}
    if (playing?.source === source) playing = null;
  };
}
