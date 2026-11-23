// Spectral envelope estimation.
//
// Primary method: cepstral smoothing. Take the log magnitude spectrum, inverse
// transform to the real cepstrum, keep only low quefrencies, transform back.
// Harmonic excitation appears as a cepstral peak at the fundamental period, so
// choosing the lifter cutoff below that period removes the comb while keeping
// formants. This is why the envelope is genuinely *spectral* (a smooth function
// of frequency) and not a per-bin copy of the spectrum.
//
// Reference level: magnitudes are |X| / (sum(w)/2), so a full-scale sinusoid
// reads 0 dB at its peak bin. Envelopes and gains in this project are dB re.
// that reference unless a different scale is stated.
//
// Frequency representation: log-spaced band centres, uniform in log2 Hz. Bands
// are a display/gap-handling grid over the cepstral envelope; the envelope
// itself is evaluated per FFT bin.
//
// Observability: a band is observed when the raw spectrum within +-0.4 octave
// of it rises above the frame's noise floor. That tests spectral support, not
// loudness: a harmonic donor is observed wherever it has partials nearby, and a
// band-limited donor's empty top octave is not. No division by near-zero is
// ever used to "predict" an unobserved band.

import { getFFT } from './fft.js';

export function bandCentres({ fMin, fMax, bandsPerOctave, sampleRate, fftSize }) {
  const nyquist = sampleRate / 2;
  const lo = Math.max(fMin, sampleRate / fftSize);
  const hi = Math.min(fMax, nyquist * 0.98);
  if (!(hi > lo)) throw new Error('empty log band range');
  const count = Math.max(2, Math.round(bandsPerOctave * Math.log2(hi / lo)) + 1);
  const centres = new Float64Array(count);
  for (let i = 0; i < count; i++) centres[i] = lo * Math.pow(hi / lo, i / (count - 1));
  return { centres, lo, hi, count };
}

export function bandBinRange(fc, bpo, binHz, bins) {
  const half = fc * (Math.pow(2, 0.5 / bpo) - 1);
  const k0 = Math.max(0, Math.floor((fc - half) / binHz));
  const k1 = Math.min(bins - 1, Math.ceil((fc + half) / binHz));
  return [k0, Math.max(k0, k1)];
}

function clampedLogMag(spec, t, floorDb) {
  const bins = spec.bins;
  const re = spec.re[t];
  const im = spec.im[t];
  const coherent = spec.coherent;
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const mag = Math.hypot(re[k], im[k]) / coherent;
    out[k] = Math.max(floorDb, 20 * Math.log10(mag + 1e-30));
  }
  return out;
}

// Real-cepstrum lifter. `quefrencySamples` is the cutoff in samples.
function lifter(logMagBins, fftSize, quefrencySamples) {
  const n = fftSize;
  const full = new Float64Array(n);
  const im = new Float64Array(n);
  const bins = logMagBins.length;
  for (let k = 0; k < bins; k++) full[k] = logMagBins[k];
  // Mirror the real spectrum for the complex inverse FFT.
  for (let k = 1; k < n / 2; k++) full[n - k] = logMagBins[k];
  const fft = getFFT(n);
  fft.inverse(full, im);
  const q = Math.max(1, Math.round(quefrencySamples));
  // Smooth taper from 0.5*q to q, then zero.
  for (let i = 0; i < n; i++) {
    const dist = Math.min(i, n - i);
    let w = 0;
    if (dist <= q * 0.5) w = 1;
    else if (dist < q) {
      const f = (dist - q * 0.5) / (q * 0.5);
      w = 0.5 + 0.5 * Math.cos(Math.PI * f);
    }
    full[i] *= w;
    im[i] = 0;
  }
  fft.forward(full, im);
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k++) out[k] = full[k];
  return out;
}

// Estimate the lifter cutoff from an externally measured period. Keeping 60 %
// of the fundamental period preserves formants whose bandwidth is under about
// 1/(pi * 0.6 * T0), and rejects the harmonic-comb cepstral peak itself.
export function lifterSamplesForPeriod(periodSec, sampleRate, fraction = 0.6) {
  if (!(periodSec > 0)) return Math.max(1, Math.round(0.003 * sampleRate));
  return Math.max(1, Math.round(fraction * periodSec * sampleRate));
}

export function estimateSpectralEnvelope(spec, opts = {}) {
  const { sampleRate, fftSize, power, frames, bins } = spec;
  const bpo = opts.bandsPerOctave ?? 12;
  const fMin = opts.fMin ?? 60;
  const fMax = opts.fMax ?? Math.min(16000, sampleRate / 2);
  const floorDb = opts.floorDb ?? -110;
  const noiseFloorDb = opts.noiseFloorDb ?? 90;
  const lifterSamples = opts.lifterSamples ?? Math.max(1, Math.round(0.003 * sampleRate));

  const { centres, lo, hi } = bandCentres({ fMin, fMax, bandsPerOctave: bpo, sampleRate, fftSize });
  const nb = centres.length;
  const binHz = sampleRate / fftSize;
  const bandRanges = new Array(nb);
  for (let b = 0; b < nb; b++) bandRanges[b] = bandBinRange(centres[b], bpo, binHz, bins);

  const envBins = new Array(frames);
  const rawBandDb = new Array(frames);
  const db = new Array(frames);
  const framePeakDb = new Float64Array(frames);
  const flatness = new Float64Array(frames);

  for (let t = 0; t < frames; t++) {
    const logMag = clampedLogMag(spec, t, floorDb);
    const smooth = lifter(logMag, fftSize, lifterSamples);
    envBins[t] = smooth;
    let peak = -Infinity;
    for (let k = 0; k < bins; k++) if (smooth[k] > peak) peak = smooth[k];
    framePeakDb[t] = peak;

    const bandDb = new Float32Array(nb);
    const rawDb = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const [k0, k1] = bandRanges[b];
      let sum = 0;
      let cnt = 0;
      let rawPeak = -Infinity;
      for (let k = k0; k <= k1; k++) {
        sum += smooth[k];
        cnt++;
        // raw dB re. coherent reference, from the un-liftered power
        const raw = 10 * Math.log10(power[t][k] + 1e-30);
        if (raw > rawPeak) rawPeak = raw;
      }
      // The smoothed envelope is an absolute level (dB re. the coherent
      // reference) and may legitimately exceed 0 dB near a strong partial, so
      // only the numerical floor is applied here. Clamping at 0 would make the
      // shape depend on absolute level, which breaks shape-domain transfer.
      bandDb[b] = Math.max(floorDb, sum / cnt);
      // rawBandDb is the *unclamped* measurement used for observability and
      // for scale checks; clamping to 0 would silently hide a quieter input.
      rawDb[b] = Math.max(floorDb, rawPeak);
    }
    db[t] = bandDb;
    rawBandDb[t] = rawDb;

    let logSum = 0;
    let count = 0;
    let total = 0;
    for (let k = 1; k < bins; k++) {
      if (power[t][k] > 0) { logSum += Math.log(power[t][k]); count++; }
      total += power[t][k];
    }
    const geo = count ? Math.exp(logSum / count) : 0;
    flatness[t] = count && total > 0 ? geo / (total / count) : 0;
  }

  // Observability from neighbourhood raw support. The floor is set by the raw
  // spectrum peak of the frame, not by the smoothed envelope: the envelope can
  // interpolate across a band-limited donor's empty region, and using it as the
  // reference would wrongly mark that region as observed.
  const support = new Array(frames);
  const supportWindow = Math.max(1, Math.round(0.4 * bpo));
  const rawPeakDb = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    let peak = -Infinity;
    for (let k = 1; k < bins; k++) {
      const v = 10 * Math.log10(power[t][k] + 1e-30);
      if (v > peak) peak = v;
    }
    rawPeakDb[t] = peak;
  }
  for (let t = 0; t < frames; t++) {
    const raw = rawBandDb[t];
    const floor = Math.max(floorDb + 5, rawPeakDb[t] - noiseFloorDb);
    const conf = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let nbMax = -Infinity;
      for (let j = Math.max(0, b - supportWindow); j <= Math.min(nb - 1, b + supportWindow); j++) {
        if (raw[j] > nbMax) nbMax = raw[j];
      }
      // A band is observed only if it holds some spectral content at all
      // (raw peak clears the absolute floor) and that content clears the
      // relative floor within its neighbourhood.
      conf[b] = raw[b] <= floorDb + 5 ? 0 : smoothstep(0, 10, nbMax - floor);
    }
    support[t] = conf;
  }

  return {
    centres,
    envBins,
    rawBandDb,
    db,
    support,
    flatness,
    framePeakDb,
    rawPeakDb,
    bandRanges,
    bandsPerOctave: bpo,
    fMin: lo,
    fMax: hi,
    floorDb,
    noiseFloorDb,
    lifterSamples,
    sampleRate,
    frames,
  };
}

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function smoothEnvelopeTime(dbFrames, hopSec, sigmaSec) {
  if (!(sigmaSec > 0) || dbFrames.length < 2) return dbFrames;
  const nb = dbFrames[0].length;
  const radius = Math.max(1, Math.round((sigmaSec * 2.5) / hopSec));
  const kernel = new Float64Array(radius * 2 + 1);
  let ks = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-0.5 * ((i * hopSec) / sigmaSec) ** 2);
    kernel[i + radius] = v;
    ks += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ks;
  const out = new Array(dbFrames.length);
  for (let t = 0; t < dbFrames.length; t++) {
    const acc = new Float32Array(nb);
    for (let j = -radius; j <= radius; j++) {
      const idx = Math.max(0, Math.min(dbFrames.length - 1, t + j));
      const kw = kernel[j + radius];
      const fr = dbFrames[idx];
      for (let b = 0; b < nb; b++) acc[b] += fr[b] * kw;
    }
    out[t] = acc;
  }
  return out;
}

// Interpolate band envelopes back onto FFT bins (log-frequency mapping).
export function envelopeToBins(envelope, spec) {
  const { bins, sampleRate, fftSize } = spec;
  const centres = envelope.centres;
  const nb = centres.length;
  const frames = envelope.db.length;
  const outDb = new Array(frames);
  const outSup = new Array(frames);
  const logSpan = Math.log2(centres[nb - 1] / centres[0]);
  for (let t = 0; t < frames; t++) {
    const e = envelope.db[t];
    const s = envelope.support ? envelope.support[t] : null;
    const d = new Float32Array(bins);
    const c = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const f = (k * sampleRate) / fftSize;
      if (f <= centres[0]) { d[k] = e[0]; c[k] = s ? s[0] : 1; continue; }
      if (f >= centres[nb - 1]) { d[k] = e[nb - 1]; c[k] = s ? s[nb - 1] : 1; continue; }
      const pos = (Math.log2(f / centres[0]) / logSpan) * (nb - 1);
      const i0 = Math.floor(pos);
      const fr = pos - i0;
      d[k] = e[i0] + (e[i0 + 1] - e[i0]) * fr;
      c[k] = s ? s[i0] + (s[i0 + 1] - s[i0]) * fr : 1;
    }
    outDb[t] = d;
    outSup[t] = c;
  }
  return { dbToBins: outDb, supportToBins: outSup };
}

export function frameTimesOf(spec) {
  const out = new Float64Array(spec.frames);
  for (let t = 0; t < spec.frames; t++) {
    out[t] = (t * spec.hop + spec.fftSize / 2 - spec.pad) / spec.sampleRate;
  }
  return out;
}
