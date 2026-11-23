// Short-time Fourier analysis and weighted overlap-add resynthesis.
//
// Magnitudes are normalised so that a full-scale sinusoid has amplitude 1.0
// (0 dB) at its peak bin: |X| / (sum(w)/2). This is the dB reference used
// throughout the application for both amplitude and spectral envelopes.

import { getFFT } from './fft.js';
import { hannWindow } from './resample.js';

export function createSTFT({ fftSize = 2048, hop = 512, sampleRate, window: win } = {}) {
  if (!(sampleRate > 0)) throw new Error('STFT needs a sample rate');
  if (!(fftSize >= 16) || (fftSize & (fftSize - 1)) !== 0) throw new Error('fftSize must be a power of two');
  if (!(hop >= 1)) throw new Error('hop must be >= 1');
  const w = win ? Float64Array.from(win) : hannWindow(fftSize, true);
  if (w.length !== fftSize) throw new Error('window length must equal fftSize');
  const coherent = w.reduce((a, b) => a + b, 0) / 2;
  const bins = fftSize / 2 + 1;
  const freqs = new Float64Array(bins);
  for (let k = 0; k < bins; k++) freqs[k] = (k * sampleRate) / fftSize;
  const pad = fftSize >> 1;
  const fft = getFFT(fftSize);

  function frameCount(len) {
    const total = len + 2 * pad;
    return Math.max(1, Math.ceil((total - fftSize) / hop) + 1);
  }

  function analyze(signal) {
    const len = signal.length;
    const frames = frameCount(len);
    const re = new Array(frames);
    const im = new Array(frames);
    const power = new Array(frames);
    const bufRe = new Float64Array(fftSize);
    const bufIm = new Float64Array(fftSize);
    for (let t = 0; t < frames; t++) {
      const start = t * hop - pad;
      for (let n = 0; n < fftSize; n++) {
        const i = start + n;
        bufRe[n] = i >= 0 && i < len ? signal[i] * w[n] : 0;
        bufIm[n] = 0;
      }
      fft.forward(bufRe, bufIm);
      const rr = new Float32Array(bins);
      const ii = new Float32Array(bins);
      const pp = new Float32Array(bins);
      for (let k = 0; k < bins; k++) {
        const a = bufRe[k] / coherent;
        const b = bufIm[k] / coherent;
        rr[k] = bufRe[k];
        ii[k] = bufIm[k];
        pp[k] = a * a + b * b;
      }
      re[t] = rr;
      im[t] = ii;
      power[t] = pp;
    }
    return { frames, bins, fftSize, hop, pad, sampleRate, freqs, coherent, window: w, re, im, power, len };
  }

  // gains: array of Float32Array(bins) (dB), silent: Uint8Array(frames)
  function synthesizeWithGain(spec, gainsDb, silent, outLen) {
    const { frames, bins: nb } = spec;
    const total = (frames - 1) * hop + fftSize;
    const acc = new Float64Array(total);
    const norm = new Float64Array(total);
    const bufRe = new Float64Array(fftSize);
    const bufIm = new Float64Array(fftSize);
    for (let t = 0; t < frames; t++) {
      const off = t * hop;
      const isSilent = silent && silent[t];
      for (let n = 0; n < fftSize; n++) {
        bufRe[n] = 0;
        bufIm[n] = 0;
        norm[off + n] += w[n] * w[n];
      }
      if (!isSilent) {
        const gain = gainsDb ? gainsDb[t] : null;
        for (let k = 0; k < nb; k++) {
          let g = 1;
          if (gain) g = Math.pow(10, gain[k] / 20);
          const rr = spec.re[t][k] * g;
          const ii = spec.im[t][k] * g;
          bufRe[k] = rr;
          bufIm[k] = ii;
          if (k > 0 && k < fftSize / 2) {
            bufRe[fftSize - k] = rr;
            bufIm[fftSize - k] = -ii;
          }
        }
        fft.inverse(bufRe, bufIm);
        for (let n = 0; n < fftSize; n++) acc[off + n] += w[n] * bufRe[n];
      }
    }
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const j = i + pad;
      const d = norm[j];
      out[i] = d > 1e-9 ? acc[j] / d : 0;
    }
    return out;
  }

  function synthesize(spec, outLen) {
    return synthesizeWithGain(spec, null, null, outLen ?? spec.len);
  }

  return { fftSize, hop, bins, freqs, sampleRate, window: w, coherent, pad, analyze, synthesize, synthesizeWithGain, frameCount };
}

// Frame RMS (amplitude envelope), in linear units and dBFS. Kept separate from
// the spectral envelope on purpose; the interface labels them differently.
export function frameRms(signal, sampleRate, frameSec = 0.02) {
  const frame = Math.max(1, Math.round(frameSec * sampleRate));
  const hop = Math.max(1, Math.round(frame / 2));
  const n = Math.max(1, Math.floor((signal.length - frame) / hop) + 1);
  const values = new Float64Array(n);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < frame; j++) {
      const v = signal[i * hop + j] ?? 0;
      s += v * v;
    }
    values[i] = Math.sqrt(s / frame);
    times[i] = (i * hop + frame / 2) / sampleRate;
  }
  return { values, times, frameSec };
}
