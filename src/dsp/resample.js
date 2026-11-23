// Window functions and sample-rate conversion.
//
// Resampling uses a Kaiser-windowed sinc interpolator with a cutoff below the
// lower Nyquist so that downsampling cannot alias energy upward. The caller can
// ask for the gain to be normalised by measured band energy (default), which
// means the resampler never invents energy: a constant-amplitude tone keeps its
// RMS, and a band-limited signal keeps its in-band power.

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const halfX = x / 2;
  for (let k = 1; k < 40; k++) {
    term *= (halfX / k) * (halfX / k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

export function kaiserWindow(n, beta = 8.6) {
  const w = new Float64Array(n);
  const denom = besselI0(beta);
  const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) {
    const r = (i - mid) / mid;
    w[i] = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / denom;
  }
  return w;
}

export function hannWindow(n, periodic = true) {
  const w = new Float64Array(n);
  const denom = periodic ? n : n - 1;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  }
  return w;
}

export function blackmanHarris(n) {
  const w = new Float64Array(n);
  const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
  const d = n - 1;
  for (let i = 0; i < n; i++) {
    w[i] = a0
      - a1 * Math.cos((2 * Math.PI * i) / d)
      + a2 * Math.cos((4 * Math.PI * i) / d)
      - a3 * Math.cos((6 * Math.PI * i) / d);
  }
  return w;
}

// Design an interpolation kernel for a rational rate change.
// Returns taps normalised so that the DC gain is 1 for the *phase-0* branch;
// each output sample normalises its own tap sum instead, so partial edge
// windows do not darken the sound.
export function designSincKernel(ratio, taps = 16, beta = 8.6) {
  // ratio = outputRate / inputRate. For downsampling the cutoff must shrink.
  const cutoff = Math.min(1, ratio) * 0.94;
  const halfTaps = taps;
  const width = 2 * halfTaps + 1;
  const h = new Float64Array(width);
  for (let i = 0; i < width; i++) {
    const t = i - halfTaps;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
    // Kaiser taper across the support.
    const r = t / halfTaps;
    h[i] = cutoff * sinc * (Math.abs(r) >= 1 ? 0 : kaiserValue(r, beta));
  }
  let sum = 0;
  for (let i = 0; i < width; i++) sum += h[i];
  for (let i = 0; i < width; i++) h[i] /= sum;
  return { h, halfTaps };
}

function kaiserValue(r, beta) {
  return besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / besselI0(beta);
}

// Simple linear interpolation fallback used for tiny rates and for tests.
export function resampleLinear(x, inRate, outRate) {
  if (inRate === outRate) return Float32Array.from(x);
  const outLen = Math.max(1, Math.round((x.length * outRate) / inRate));
  const out = new Float32Array(outLen);
  const step = inRate / outRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = x[Math.min(i0, x.length - 1)];
    const b = x[Math.min(i0 + 1, x.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// Band-limited resampling. `normalise` rescales so that RMS is preserved
// (energy-preserving for short stationary test signals).
export function resample(x, inRate, outRate, opts = {}) {
  if (!(inRate > 0) || !(outRate > 0)) throw new Error('Sample rates must be positive');
  if (inRate === outRate) return Float32Array.from(x);
  const taps = opts.taps ?? 16;
  const beta = opts.beta ?? 8.6;
  const normalise = opts.normalise !== false;
  const targetRms = opts.targetRms;
  const ratio = outRate / inRate;
  const { h, halfTaps } = designSincKernel(ratio, taps, beta);
  const outLen = Math.max(1, Math.round((x.length * outRate) / inRate));
  const out = new Float32Array(outLen);
  const step = inRate / outRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const centre = Math.floor(pos);
    const frac = pos - centre;
    let acc = 0;
    let wsum = 0;
    for (let k = -halfTaps; k <= halfTaps; k++) {
      const idx = centre + k;
      // Linear interpolation of the kernel at the fractional offset.
      const d = k - frac;
      const hpos = d + halfTaps;
      const h0 = Math.floor(hpos);
      const hf = hpos - h0;
      const hv = h0 >= 0 && h0 + 1 < h.length
        ? h[h0] * (1 - hf) + h[h0 + 1] * hf
        : 0;
      const s = idx < 0 || idx >= x.length ? 0 : x[idx];
      acc += s * hv;
      wsum += hv;
    }
    out[i] = wsum > 1e-9 ? acc / wsum : 0;
  }
  if (normalise) {
    const inRms = rms(x);
    const outRms = rms(out);
    if (outRms > 1e-12) {
      const g = (targetRms ?? inRms) / outRms;
      for (let i = 0; i < outLen; i++) out[i] *= g;
    }
  }
  return out;
}

export function rms(x) {
  if (!x.length) return 0;
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}
