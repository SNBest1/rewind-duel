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
      noise(0.07, 0.3, 'highpass', 1400);
      tone(240, 80, 0.06, 'square', 0.06);
    } else {
      noise(0.11, 0.35, 'lowpass', 1000, pan);
      tone(150, 50, 0.09, 'square', 0.05, pan);
    }
  },
  hit: () => tone(1700, 1700, 0.05, 'sine', 0.18),
  hurt: (pan: number) => tone(170, 45, 0.2, 'sawtooth', 0.18, pan),
  kill: () => {
    tone(523, 523, 0.09, 'triangle', 0.22);
    tone(784, 784, 0.16, 'triangle', 0.22, 0, 0.09);
  },
  dash: (pan: number) => noise(0.16, 0.18, 'bandpass', 2200, pan),
  smoke: (pan: number) => noise(0.4, 0.2, 'lowpass', 500, pan),
  beep: () => tone(1250, 1250, 0.035, 'sine', 0.12),
  plant: () => tone(330, 990, 0.25, 'triangle', 0.18),
  roundStart: () => {
    tone(440, 440, 0.07, 'square', 0.06);
    tone(660, 660, 0.1, 'square', 0.06, 0, 0.1);
  },
  roundEnd: (won: boolean) => {
    tone(won ? 392 : 330, won ? 392 : 330, 0.12, 'triangle', 0.18);
    tone(won ? 587 : 247, won ? 587 : 247, 0.3, 'triangle', 0.18, 0, 0.12);
  },
};
