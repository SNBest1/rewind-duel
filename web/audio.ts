// Synthesized sound cues. No audio files: every sound is an oscillator or filtered noise built on the spot.

let ac: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;

/** Must be called from a user gesture (the Join click), or browsers keep the context suspended. */
export function initAudio(): void {
  ac ??= new AudioContext();
  void ac.resume();
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
}

export function toggleMute(): boolean {
  return (muted = !muted);
}

/** A gain node routed through a stereo panner; `pan` is -1 (left) to 1 (right). */
function out(gain: number, pan: number, at: number, dur: number): GainNode | null {
  if (!ac || muted) return null;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  const p = ac.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  g.connect(p).connect(ac.destination);
  return g;
}

function tone(f0: number, f1: number, dur: number, type: OscillatorType, gain: number, pan = 0, delay = 0): void {
  if (!ac) return;
  const at = ac.currentTime + delay;
  const g = out(gain, pan, at, dur);
  if (!g) return;
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, at);
  o.frequency.exponentialRampToValueAtTime(f1, at + dur);
  o.connect(g);
  o.start(at);
  o.stop(at + dur);
}

function noise(dur: number, gain: number, filter: BiquadFilterType, freq: number, pan = 0): void {
  if (!ac || !noiseBuf) return;
  const at = ac.currentTime;
  const g = out(gain, pan, at, dur);
  if (!g) return;
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const f = ac.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  src.connect(f).connect(g);
  src.start(at, Math.random() * 0.5, dur);
}

export const sfx = {
  shot(mine: boolean, pan: number): void {
    if (mine) {
      // Punchy rifle crack: bright transient + mid body + low thump.
      noise(0.05, 0.42, 'highpass', 2000);
      noise(0.09, 0.22, 'bandpass', 900);
      tone(260, 70, 0.07, 'square', 0.09);
      tone(90, 45, 0.11, 'sine', 0.07);
    } else {
      // Enemy shot: muffled and distance-panned.
      noise(0.12, 0.34, 'lowpass', 900, pan);
      tone(140, 48, 0.1, 'square', 0.06, pan);
      tone(70, 40, 0.13, 'sine', 0.05, pan);
    }
  },
  // Metallic hit-marker "tink" with a short overtone.
  hit: () => {
    tone(1850, 1850, 0.05, 'sine', 0.2);
    tone(2600, 2400, 0.04, 'triangle', 0.08, 0, 0.01);
  },
  hurt: (pan: number) => {
    tone(170, 45, 0.22, 'sawtooth', 0.2, pan);
    noise(0.1, 0.14, 'lowpass', 600, pan);
  },
  // Rising two-note chime with a deep bass tail on a kill.
  kill: () => {
    tone(523, 523, 0.09, 'triangle', 0.22);
    tone(784, 784, 0.16, 'triangle', 0.22, 0, 0.09);
    tone(110, 90, 0.4, 'sine', 0.16, 0, 0.02);
  },
  dash: (pan: number) => {
    noise(0.16, 0.2, 'bandpass', 2200, pan);
    tone(600, 1400, 0.12, 'sine', 0.06, pan);
  },
  smoke: (pan: number) => noise(0.42, 0.22, 'lowpass', 480, pan),
  // Headshot: a bright metallic dink over the hit marker.
  head: () => {
    tone(3200, 3000, 0.07, 'triangle', 0.22);
    tone(4700, 4300, 0.05, 'sine', 0.12, 0, 0.01);
    tone(1850, 1850, 0.04, 'sine', 0.12);
  },
  buy: () => {
    tone(880, 1320, 0.06, 'square', 0.05);
    tone(1320, 1320, 0.05, 'triangle', 0.06, 0, 0.06);
  },
  rankUp: (up: boolean) => {
    const notes = up ? [392, 523, 659, 784] : [523, 440, 349];
    notes.forEach((f, i) => tone(f, f, 0.18, 'triangle', 0.16, 0, i * 0.09));
  },
  // Crisp footstep tick (played while running without walk).
  step: (pan: number) => noise(0.05, 0.08, 'bandpass', 1600, pan),
  beep: () => tone(1250, 1250, 0.035, 'sine', 0.12),
  plant: () => tone(330, 990, 0.25, 'triangle', 0.18),
  // Flashbang: pin pull and spoon flick on the throw...
  flashPin: (pan: number) => {
    tone(2200, 1900, 0.03, 'square', 0.08, pan);
    tone(900, 700, 0.05, 'triangle', 0.06, pan, 0.05);
  },
  // ...a sharp pop everyone hears...
  flashPop: (pan: number) => {
    noise(0.22, 0.5, 'highpass', 700, pan);
    tone(220, 60, 0.15, 'sine', 0.2, pan);
  },
  // ...and the ringing in your ears, only if it caught you. Louder and longer for a full flash.
  flashRing: (strength: number) => {
    const s = Math.max(0.3, Math.min(1, strength));
    tone(4200, 3900, 2.2 * s, 'sine', 0.13 * s);
    tone(4700, 4500, 1.6 * s, 'sine', 0.05 * s);
  },
  teleport: (pan: number) => {
    tone(300, 1200, 0.18, 'sine', 0.12, pan);
    noise(0.15, 0.1, 'bandpass', 3000, pan);
  },
  roundStart: () => {
    tone(440, 440, 0.07, 'square', 0.06);
    tone(660, 660, 0.1, 'square', 0.06, 0, 0.1);
  },
  roundEnd: (won: boolean) => {
    tone(won ? 392 : 330, won ? 392 : 330, 0.12, 'triangle', 0.18);
    tone(won ? 587 : 247, won ? 587 : 247, 0.3, 'triangle', 0.18, 0, 0.12);
  },
};
