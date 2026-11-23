// Cross-synthesis: transplant a slowly varying spectral envelope from a donor
// onto the excitation structure of a carrier.
//
// Model, stated plainly because the interface repeats it:
//   * donor  -> slow log-frequency *spectral* envelope (cepstral smoothing).
//   * carrier-> an "excitation proxy": its fine spectral detail, i.e. magnitude
//               divided by its own spectral envelope.
//   * result -> carrier detail multiplied by the donor envelope *shape*.
//
// This is a spectral-envelope transfer, not a source/filter separation. The
// carrier residual is only "excitation-like". For polyphonic or strongly
// inharmonic material the envelope is not a physical filter and the residual is
// not a physical source; the report says where the model stops being valid.
//
// Both envelopes are estimated with the same cepstral method (envelope.js), so
// subtracting them in dB is well defined and yields a smooth, bounded gain:
//
//   gain(bin) = [Ed(bin) - refD] - [Ec(bin) - refC]
//
// The two references refD/refC are the energy-mean levels of each envelope over
// the bands the donor observes. Removing them transplants *shape*, not absolute
// level; the removed constant is restored explicitly by the output-gain stage.
//
// Guards, in order:
//   1. donor band observability from a neighbourhood support test;
//   2. explicit gap strategies (extrapolate / hold / bypass) for unobserved
//      donor bands, with bounded extrapolation;
//   3. excitation support: where the carrier has no local energy gain is zeroed,
//      so no partial is manufactured from numerical noise;
//   4. clamp [maxCutDb, maxBoostDb].
// The broadband amplitude envelope is handled afterwards, audited separately,
// and never folded into the spectral claim.

import { createSTFT, frameRms } from './stft.js';
import { resample, rms, peak } from './resample.js';
import {
  estimateSpectralEnvelope,
  envelopeToBins,
  smoothEnvelopeTime,
  smoothstep,
  clamp01,
  lifterSamplesForPeriod,
} from './envelope.js';

export const DEFAULT_OPTIONS = Object.freeze({
  workRate: null,
  maxWorkRate: 48000,
  fftSize: 2048,
  hop: 512,
  bandsPerOctave: 12,
  fMin: 60,
  fMax: null,
  envSmoothOctaves: 0.12,
  envSmoothSec: 0.15,
  noiseFloorDb: 90,
  confidenceThreshold: 0.5,
  confidenceFadeBands: 1,
  lifterFraction: 0.6,
  lifterFallbackSec: 0.003,
  timeMap: 'stretch',          // 'stretch' | 'start' | 'offset'
  timeOffsetSec: 0,
  timeGapMode: 'hold',         // 'hold' | 'bypass'
  freqGapMode: 'extrapolate',  // 'extrapolate' | 'hold' | 'bypass'
  extrapolateMaxRiseDb: 6,
  extrapolateMaxFallDb: 18,
  maxBoostDb: 18,
  maxCutDb: 60,
  excitationRangeDb: 70,
  excitationFloor: 0.10,
  preserveCarrierLoudness: true,
  loudnessFrameSec: 0.02,
  maxMakeupDb: 30,
  outputGainMode: 'carrier-rms', // 'carrier-rms' | 'unity' | 'explicit'
  outputGainDb: 0,
  peakCeiling: 0.98,
  outputDurationSec: null,
  excitationSoloMaxBoostDb: 40,
  measurabilityFloorDb: 80,
});

export function mergeOptions(opts = {}) {
  return { ...DEFAULT_OPTIONS, ...opts };
}

const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const powerToDb = (p) => 10 * Math.log10(p + 1e-30);

function ensureSignal(sig, name) {
  if (!sig || !sig.samples || !sig.samples.length) throw new Error(`${name}: empty signal`);
  if (!(sig.sampleRate > 0)) throw new Error(`${name}: missing sample rate`);
  return sig;
}

// ---------------------------------------------------------------------------
// Period estimation (autocorrelation, octave-error-guarded)
// ---------------------------------------------------------------------------

export function estimatePeriod(signal, sampleRate, opts = {}) {
  const minHz = opts.minHz ?? 50;
  const maxHz = opts.maxHz ?? 1200;
  const segSec = opts.segmentSec ?? 0.5;
  const rate = Math.min(opts.analysisRate ?? 8000, sampleRate);
  const down = resample(signal, sampleRate, rate, { normalise: false, taps: 8 });
  const n = Math.min(down.length, Math.round(segSec * rate));
  if (n < 64) return { hz: 0, clarity: 0, lagSec: 0 };
  const start = Math.max(0, Math.floor((down.length - n) / 2));
  let mean = 0;
  for (let i = 0; i < n; i++) mean += down[start + i];
  mean /= n;
  const x = new Float32Array(n);
  let e0 = 0;
  for (let i = 0; i < n; i++) {
    const v = down[start + i] - mean;
    x[i] = v;
    e0 += v * v;
  }
  if (e0 < 1e-12) return { hz: 0, clarity: 0, lagSec: 0 };
  const minLag = Math.max(2, Math.floor(rate / maxHz));
  const maxLag = Math.min(n - 2, Math.ceil(rate / minHz));
  const corr = new Float32Array(maxLag + 2);
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += x[i] * x[i + lag];
    const c = s / (e0 * (1 - lag / n));
    corr[lag] = c;
    if (c > best) { best = c; bestLag = lag; }
  }
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1] && corr[lag] > 0.9 * best) {
      bestLag = lag;
      best = corr[lag];
      break;
    }
  }
  // No meaningful periodicity: report no period rather than a spurious one.
  // Noise reads a peak autocorrelation around 0.1-0.3; a real pulse train or
  // tone reads > 0.6.
  if (best < (opts.minClarity ?? 0.5)) {
    return { hz: 0, clarity: clamp01(best), lagSec: bestLag / rate, periodic: false };
  }
  return { hz: rate / bestLag, clarity: clamp01(best), lagSec: bestLag / rate, periodic: true };
}

// ---------------------------------------------------------------------------
// Gap strategies (band domain, shape domain)
// ---------------------------------------------------------------------------

function nearest(mask, from, dir) {
  for (let i = from; i >= 0 && i < mask.length; i += dir) if (mask[i]) return i;
  return -1;
}

// Fill unobserved bands from observed anchors. Operates on the shape (dB
// relative to the reference). 'extrapolate' continues the log-frequency slope,
// bounded so a wide unobserved region cannot invent a large slope. 'hold'
// repeats the nearest anchor. 'bypass' fills nothing; the caller passes the
// carrier through (gain 0) there.
function fillShape(shapeDb, conf, threshold, mode, bounds) {
  const n = shapeDb.length;
  const out = Float32Array.from(shapeDb);
  const observed = new Uint8Array(n);
  let first = -1;
  let last = -1;
  for (let b = 0; b < n; b++) {
    if (conf[b] >= threshold) {
      observed[b] = 1;
      if (first < 0) first = b;
      last = b;
    }
  }
  const filled = new Uint8Array(n);
  if (first < 0) {
    out.fill(-bounds.floorDb);
    filled.fill(1);
    return { shape: out, filled, observed, any: false };
  }

  let prev = first;
  for (let b = first + 1; b <= last; b++) {
    if (!observed[b]) continue;
    if (b - prev > 1) {
      for (let j = prev + 1; j < b; j++) {
        const f = (j - prev) / (b - prev);
        out[j] = shapeDb[prev] + (shapeDb[b] - shapeDb[prev]) * f;
        filled[j] = 1;
      }
    }
    prev = b;
  }

  const bound = (value, anchor) => Math.max(
    -bounds.floorDb,
    Math.min(anchor + bounds.maxRiseDb, Math.max(anchor - bounds.maxFallDb, value)),
  );
  if (first > 0) {
    const p2 = nearest(observed, first + 1, 1);
    const slope = p2 >= 0 ? (shapeDb[first] - shapeDb[p2]) / (p2 - first) : 0;
    for (let j = 0; j < first; j++) {
      out[j] = mode === 'extrapolate'
        ? bound(shapeDb[first] + slope * (first - j), shapeDb[first])
        : shapeDb[first];
      filled[j] = 1;
    }
  }
  if (last < n - 1) {
    const p1 = nearest(observed, last - 1, -1);
    const slope = p1 >= 0 ? (shapeDb[last] - shapeDb[p1]) / (last - p1) : 0;
    for (let j = last + 1; j < n; j++) {
      out[j] = mode === 'extrapolate'
        ? bound(shapeDb[last] + slope * (j - last), shapeDb[last])
        : shapeDb[last];
      filled[j] = 1;
    }
  }
  return { shape: out, filled, observed, any: true, first, last };
}

// ---------------------------------------------------------------------------
// Time correspondence
// ---------------------------------------------------------------------------

function mapTime(tSec, carrierDur, donorDur, options, tolSec = 0) {
  let mapped;
  if (options.timeMap === 'stretch') {
    // Frame-centre times can land a hair past the nominal duration; clamp so a
    // stretched map covers every carrier frame.
    const tc = Math.max(0, Math.min(carrierDur, tSec));
    mapped = carrierDur > 0 ? (tc / carrierDur) * donorDur : 0;
  } else if (options.timeMap === 'offset') {
    mapped = tSec - options.timeOffsetSec;
  } else {
    mapped = tSec;
  }
  return { mapped, inside: mapped >= -tolSec && mapped <= donorDur + tolSec };
}

function interpFrame(arr, pos) {
  const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(pos)));
  const i1 = Math.min(arr.length - 1, i0 + 1);
  const f = Math.max(0, Math.min(1, pos - i0));
  const a = arr[i0];
  const b = arr[i1];
  if (a === b || f === 0) return a;
  const out = new Float32Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] + (b[k] - a[k]) * f;
  return out;
}

// Map band arrays onto FFT bins with the same log-frequency interpolation as
// the envelope, so band masks stay aligned with bin-level data.
function bandToBins(arr, centres, bins, sampleRate, fftSize) {
  const nb = centres.length;
  const out = new Float32Array(bins);
  const logSpan = Math.log2(centres[nb - 1] / centres[0]);
  for (let k = 0; k < bins; k++) {
    const f = (k * sampleRate) / fftSize;
    if (f <= centres[0]) { out[k] = arr[0]; continue; }
    if (f >= centres[nb - 1]) { out[k] = arr[nb - 1]; continue; }
    const pos = (Math.log2(f / centres[0]) / logSpan) * (nb - 1);
    const i0 = Math.floor(pos);
    const fr = pos - i0;
    out[k] = arr[i0] + (arr[i0 + 1] - arr[i0]) * fr;
  }
  return out;
}

// Level of a band envelope over observed bands (energy mean, dB).
export function bandReferenceDb(bandDb, conf, threshold) {
  let sum = 0;
  let count = 0;
  for (let b = 0; b < bandDb.length; b++) {
    if (conf[b] < threshold) continue;
    sum += Math.pow(10, bandDb[b] / 10);
    count++;
  }
  if (!count) {
    for (let b = 0; b < bandDb.length; b++) {
      sum += Math.pow(10, bandDb[b] / 10);
      count++;
    }
  }
  return count ? 10 * Math.log10(sum / count + 1e-30) : 0;
}

// ---------------------------------------------------------------------------
// Excitation support
// ---------------------------------------------------------------------------

function excitationSupport(spec, options, bandRanges, nbBands) {
  const { frames, bins, power } = spec;
  const support = new Array(frames);
  const unexcited = new Array(frames);
  const peaks = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const p = power[t];
    let framePeak = 0;
    for (let k = 1; k < bins; k++) if (p[k] > framePeak) framePeak = p[k];
    const framePeakDb = powerToDb(framePeak);
    peaks[t] = framePeakDb;
    const sup = new Float32Array(bins);
    const unex = new Uint8Array(bins);
    // Reference is the *frame* peak, not the per-band peak. A partial that is
    // 40 dB below the frame's loudest is still excitation; a bin 100 dB down is
    // numerical floor. Using the per-band peak would mark every band's own
    // maximum as fully supported, including empty bands.
    for (let b = 0; b < nbBands; b++) {
      const [k0, k1] = bandRanges[b];
      for (let k = k0; k <= k1; k++) {
        const rel = powerToDb(p[k]) - framePeakDb;
        const s = smoothstep(-options.excitationRangeDb, -6, rel);
        sup[k] = s;
        if (s < options.excitationFloor) unex[k] = 1;
      }
    }
    support[t] = sup;
    unexcited[t] = unex;
  }
  return { support, unexcited, framePeakDb: peaks };
}

// ---------------------------------------------------------------------------
// Signal preparation
// ---------------------------------------------------------------------------

export function prepareSignal(signal, workRate, specOpts, envOpts, options, label) {
  ensureSignal(signal, label);
  const resampled = signal.sampleRate === workRate
    ? Float32Array.from(signal.samples)
    : resample(signal.samples, signal.sampleRate, workRate, { normalise: true });
  const stft = createSTFT({ fftSize: specOpts.fftSize, hop: specOpts.hop, sampleRate: workRate });
  const spec = stft.analyze(resampled);
  const period = estimatePeriod(resampled, workRate);
  const lifterSamples = period.clarity >= 0.35 && period.lagSec > 0
    ? lifterSamplesForPeriod(period.lagSec, workRate, options.lifterFraction)
    : Math.max(1, Math.round(options.lifterFallbackSec * workRate));
  const env = estimateSpectralEnvelope(spec, { ...envOpts, lifterSamples });
  const amp = frameRms(resampled, workRate, specOpts.loudnessFrameSec);
  const inRms = rms(signal.samples);
  const outRms = rms(resampled);
  return {
    label,
    inputRate: signal.sampleRate,
    workRate,
    inputSamples: signal.samples,
    samples: resampled,
    inputRms: inRms,
    inputPeak: peak(signal.samples),
    rms: outRms,
    peak: peak(resampled),
    durationSec: resampled.length / workRate,
    stft,
    spec,
    env,
    amp,
    period,
    lifterSamples,
    resampleGain: inRms > 1e-12 ? outRms / inRms : 1,
  };
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

export function crossSynthesize(donorSignal, carrierSignal, userOptions = {}) {
  const options = mergeOptions(userOptions);
  ensureSignal(donorSignal, 'donor');
  ensureSignal(carrierSignal, 'carrier');

  const requestedRate = options.workRate ?? Math.max(donorSignal.sampleRate, carrierSignal.sampleRate);
  const workRate = Math.min(requestedRate, options.maxWorkRate);
  const fftSize = options.fftSize;
  const hop = options.hop;
  const hopSec = hop / workRate;
  const binHz = workRate / fftSize;
  const envOpts = {
    bandsPerOctave: options.bandsPerOctave,
    fMin: options.fMin,
    fMax: options.fMax ?? Math.min(16000, workRate / 2),
    floorDb: -110,
    noiseFloorDb: options.noiseFloorDb,
  };
  const specOpts = { fftSize, hop, sampleRate: workRate, loudnessFrameSec: options.loudnessFrameSec };

  const donor = prepareSignal(donorSignal, workRate, specOpts, envOpts, options, 'donor');
  const carrier = prepareSignal(carrierSignal, workRate, specOpts, envOpts, options, 'carrier');
  const nb = donor.env.centres.length;
  const bins = carrier.spec.bins;
  const cf = carrier.spec.frames;
  const donorFrames = donor.spec.frames;
  const carrierDur = carrier.durationSec;
  const donorDur = donor.durationSec;
  const threshold = options.confidenceThreshold;
  const centres = donor.env.centres;
  // Bins inside the declared band range. Outside it the model makes no claim,
  // so those bins are passed through untouched and excluded from statistics.
  const envFMin = envOpts.fMin;
  const envFMax = envOpts.fMax ?? Math.min(16000, workRate / 2);
  const kLo = Math.max(1, Math.ceil(envFMin / binHz));
  const kHi = Math.min(bins - 1, Math.floor(envFMax / binHz));

  // Slow time smoothing belongs to the donor only.
  const donorEnvDb = smoothEnvelopeTime(donor.env.db, hopSec, options.envSmoothSec);
  const carrierEnvDb = smoothEnvelopeTime(carrier.env.db, hopSec, Math.min(0.04, options.envSmoothSec / 4));
  const donorEnv = { ...donor.env, db: donorEnvDb };
  const carrierEnv = { ...carrier.env, db: carrierEnvDb };

  // Donor band shape, gap-resolved per donor frame.
  const donorShapes = new Array(donorFrames);
  const donorFill = new Array(donorFrames);
  const donorObs = new Array(donorFrames);
  const donorRefs = new Float32Array(donorFrames);
  const bounds = {
    floorDb: 160,
    maxRiseDb: options.extrapolateMaxRiseDb,
    maxFallDb: options.extrapolateMaxFallDb,
  };
  for (let t = 0; t < donorFrames; t++) {
    const conf = donor.env.support[t];
    const ref = bandReferenceDb(donorEnvDb[t], conf, threshold);
    donorRefs[t] = ref;
    const shape = new Float32Array(nb);
    for (let b = 0; b < nb; b++) shape[b] = donorEnvDb[t][b] - ref;
    if (options.freqGapMode === 'bypass') {
      donorShapes[t] = shape;
      donorFill[t] = new Uint8Array(nb);
      donorObs[t] = conf;
    } else {
      const r = fillShape(shape, conf, threshold, options.freqGapMode, bounds);
      donorShapes[t] = r.shape;
      donorFill[t] = r.filled;
      donorObs[t] = r.observed;
    }
  }

  const carrierBins = envelopeToBins(carrierEnv, carrier.spec);
  const exc = excitationSupport(carrier.spec, options, carrier.env.bandRanges, nb);
  const unexcitedBins = exc.unexcited;

  const gainsDb = new Array(cf);
  const targetShapeBand = new Array(cf);
  const targetShapeBins = new Array(cf);
  const donorObsBins = new Array(cf);
  const donorFillBins = new Array(cf);
  const carrierShapeBins = new Array(cf);
  const bypassedFrames = new Uint8Array(cf);
  const coverage = new Uint8Array(cf);
  const refs = new Array(cf);

  const stats = {
    covered: 0, held: 0, bypassed: 0,
    donorGapBins: 0, unexcitedBins: 0, refusedBoostBins: 0,
    binTotal: 0, gainMin: Infinity, gainMax: -Infinity,
  };

  for (let t = 0; t < cf; t++) {
    const tSec = (t * hop + fftSize / 2 - carrier.spec.pad) / workRate;
    const { mapped, inside } = mapTime(tSec, carrierDur, donorDur, options);
    const held = !inside && options.timeGapMode === 'hold';
    const bypassed = !inside && options.timeGapMode === 'bypass';
    let pos = mapped / hopSec;
    if (bypassed) {
      bypassedFrames[t] = 1;
      stats.bypassed++;
      pos = 0;
    } else {
      coverage[t] = 1;
      stats.covered++;
      if (held) stats.held++;
      pos = Math.max(0, Math.min(donorFrames - 1, pos));
    }

    const confB = interpFrame(donorObs, pos);
    const shapeB = interpFrame(donorShapes, pos);
    const fillB = interpFrame(donorFill, pos);
    const i0 = Math.floor(pos);
    const i1 = Math.min(donorFrames - 1, i0 + 1);
    const fpos = pos - i0;
    const refD = donorRefs[i0] * (1 - fpos) + donorRefs[i1] * fpos;

    // Carrier reference over the bands the donor observes at this frame.
    const refC = bandReferenceDb(carrierEnvDb[t], confB, threshold);

    const targetBinBand = bandToBins(shapeB, centres, bins, workRate, fftSize);
    const obsBin = bandToBins(confB, centres, bins, workRate, fftSize);
    const fillBinF = bandToBins(fillB, centres, bins, workRate, fftSize);
    const carBin = carrierBins.dbToBins[t];
    const carShapeRaw = new Float32Array(bins);
    for (let k = 0; k < bins; k++) carShapeRaw[k] = carBin[k] - refC;

    const g = new Float32Array(bins);
    const fillMask = new Uint8Array(bins);
    const target = new Float32Array(bins);
    const excSupFrame = exc.support[t];
    for (let k = 0; k < bins; k++) {
      // Outside the declared band range the model makes no claim: leave the bin
      // untouched and exclude it from every coverage/gap statistic. Treating it
      // as a "donor gap" would inflate the extrapolated share with bins the user
      // explicitly excluded.
      if (k < kLo || k > kHi) {
        g[k] = 0;
        target[k] = carShapeRaw[k];
        continue;
      }
      const observed = obsBin[k] >= threshold;
      const bypassThis = bypassed || (options.freqGapMode === 'bypass' && !observed);
      // Target shape: donor (gap-resolved) unless bypassed, then carrier itself.
      const tShape = bypassThis ? carShapeRaw[k] : targetBinBand[k];
      target[k] = tShape;
      if (fillBinF[k] > 0.5 && !bypassThis) { fillMask[k] = 1; stats.donorGapBins++; }
      let gain = bypassThis ? 0 : tShape - carShapeRaw[k];
      if (gain > options.maxBoostDb) gain = options.maxBoostDb;
      if (gain < -options.maxCutDb) gain = -options.maxCutDb;
      const sup = excSupFrame[k];
      if (sup < options.excitationFloor) {
        // No excitation here: allow attenuation, never boost. A tiny positive
        // residual (numerical, not audible) is not turned into a 0 dB claim.
        if (gain > 0) { gain = 0; stats.refusedBoostBins++; }
        if (unexcitedBins[t][k]) stats.unexcitedBins++;
      }
      if (gain > stats.gainMax) stats.gainMax = gain;
      if (gain < stats.gainMin) stats.gainMin = gain;
      g[k] = gain;
      stats.binTotal++;
    }
    gainsDb[t] = g;
    targetShapeBins[t] = target;
    targetShapeBand[t] = shapeB;
    donorObsBins[t] = obsBin;
    donorFillBins[t] = fillMask;
    carrierShapeBins[t] = carShapeRaw;
    refs[t] = { donor: refD, carrier: refC, diff: refD - refC };
  }

  // Excitation solo: carrier with its own envelope divided out, bounded and
  // weighted by support. It is the proxy the donor acts on, not a source.
  const excitationDb = new Array(cf);
  for (let t = 0; t < cf; t++) {
    const g = new Float32Array(bins);
    const sup = exc.support[t];
    for (let k = 0; k < bins; k++) {
      let inv = -carrierBins.dbToBins[t][k] * sup[k];
      if (inv > options.excitationSoloMaxBoostDb) inv = options.excitationSoloMaxBoostDb;
      if (inv < -60) inv = -60;
      g[k] = inv;
    }
    excitationDb[t] = g;
  }
  let excitation = carrier.stft.synthesizeWithGain(carrier.spec, excitationDb, null, carrier.samples.length);
  excitation = scaleToRms(excitation, carrier.rms, 24);

  let spectralOutput = carrier.stft.synthesizeWithGain(carrier.spec, gainsDb, bypassedFrames, carrier.samples.length);

  if (options.outputDurationSec && options.outputDurationSec > 0) {
    const want = Math.max(1, Math.round(options.outputDurationSec * workRate));
    const resized = new Float32Array(want);
    resized.set(spectralOutput.subarray(0, Math.min(want, spectralOutput.length)));
    spectralOutput = resized;
  }

  const spectralAudit = auditSpectralStage({ carrier, spectralOutput, gainsDb, donorFillBins, unexcitedBins, options });

  let output = spectralOutput;
  let loudnessInfo = null;
  if (options.preserveCarrierLoudness) {
    loudnessInfo = matchLoudnessEnvelope(output, carrier.samples, workRate, options);
    output = loudnessInfo.out;
  }

  const preGainRms = rms(output);
  let makeupDb = 0;
  if (options.outputGainMode === 'carrier-rms') {
    if (preGainRms > 1e-9 && carrier.rms > 1e-9) makeupDb = linToDb(carrier.rms / preGainRms);
  } else if (options.outputGainMode === 'explicit') {
    makeupDb = options.outputGainDb;
  }
  makeupDb = Math.max(-60, Math.min(options.maxMakeupDb, makeupDb));
  const guardMuted = preGainRms < 1e-9;
  if (guardMuted) {
    for (let i = 0; i < output.length; i++) output[i] = 0;
  } else {
    const g = dbToLin(makeupDb);
    for (let i = 0; i < output.length; i++) output[i] *= g;
  }
  let peakGuardDb = 0;
  const pk = peak(output);
  if (pk > options.peakCeiling) {
    peakGuardDb = linToDb(options.peakCeiling / pk);
    const g = dbToLin(peakGuardDb);
    for (let i = 0; i < output.length; i++) output[i] *= g;
  }

  // Verification analysis of the final output. The output is carrier-excited,
  // so its comb has the carrier's period: derive the lifter from the output's
  // own measured period, not the donor's. Using a lifter longer than the output
  // period would let the comb leak into the "smooth" envelope.
  const outSpec = carrier.stft.analyze(output);
  const outputPeriodForEnv = estimatePeriod(output, workRate);
  const outLifter = outputPeriodForEnv.clarity >= 0.35 && outputPeriodForEnv.lagSec > 0
    ? lifterSamplesForPeriod(outputPeriodForEnv.lagSec, workRate, options.lifterFraction)
    : Math.max(1, Math.round(options.lifterFallbackSec * workRate));
  const outEnvRaw = estimateSpectralEnvelope(outSpec, { ...envOpts, lifterSamples: outLifter });
  const outEnvSmoothDb = smoothEnvelopeTime(outEnvRaw.db, hopSec, options.envSmoothSec);
  const outEnv = { ...outEnvRaw, db: outEnvSmoothDb };
  const outAmp = frameRms(output, workRate, options.loudnessFrameSec);

  // Donor band shape at carrier frames, for display only.
  const donorShapeAtCarrier = new Array(cf);
  for (let t = 0; t < cf; t++) {
    const tSec = (t * hop + fftSize / 2 - carrier.spec.pad) / workRate;
    const { mapped } = mapTime(tSec, carrierDur, donorDur, options);
    const pos = Math.max(0, Math.min(donorFrames - 1, mapped / hopSec));
    donorShapeAtCarrier[t] = Float32Array.from(interpFrame(donorShapes, pos));
  }

  const analysis = analyseResult({
    options, workRate, fftSize, hop, binHz, hopSec,
    donor, carrier, output, spectralOutput, excitation,
    donorEnv, carrierEnv, outEnv, outEnvRaw, outAmp, outSpec, outLifter,
    donorShapes, donorShapeAtCarrier, targetShapeBand, targetShapeBins,
    donorObsBins, donorFillBins, carrierShapeBins, gainsDb,
    carrierExcitation: exc.support, unexcitedBins, bypassedFrames, coverage, stats,
    loudnessInfo, makeupDb, peakGuardDb, preGainRms, guardMuted, spectralAudit,
  });

  return {
    workRate,
    options,
    donor,
    carrier,
    output,
    spectralOutput,
    excitation,
    outSpec,
    outEnv,
    outEnvRaw,
    outAmp,
    donorEnv,
    donorShapes,
    donorShapeAtCarrier,
    carrierEnv,
    gainsDb,
    targetShapeBins,
    targetShapeBand,
    donorObsBins,
    donorFillBins,
    carrierShapeBins,
    carrierExcitation: exc.support,
    unexcitedBins,
    bypassedFrames,
    coverage,
    refs,
    metrics: analysis.metrics,
    images: buildImages({
      donor, carrier, outSpec, outEnv, outAmp,
      donorEnv, donorShapes, carrierEnv, gainsDb, targetShapeBins,
      donorObsBins, donorFillBins, carrierExcitation: exc.support, unexcitedBins, bypassedFrames,
      spectralOutput, workRate,
    }),
    loudnessInfo,
    spectralAudit,
    sampleRate: workRate,
  };
}

// ---------------------------------------------------------------------------
// Energy audit (explicit, before loudness/makeup)
// ---------------------------------------------------------------------------

function auditSpectralStage({ carrier, spectralOutput, gainsDb, donorFillBins, unexcitedBins, options }) {
  const outSpec = carrier.stft.analyze(spectralOutput);
  const cf = carrier.spec.frames;
  const bins = carrier.spec.bins;
  const measFloor = options.measurabilityFloorDb;

  let carrierTotal = 0;
  let outTotal = 0;
  let predictedTotal = 0;
  let maxBoostUnexc = -Infinity;
  // Donor-unobserved region: bands the donor did not see, where any added
  // energy would be extrapolation or bypass, not evidence.
  let gapCarrier = 0;
  let gapOut = 0;
  let gapCarrierMeas = 0;
  let gapOutMeas = 0;
  // Unexcited (carrier floor) region.
  let unexcCarrier = 0;
  let unexcOut = 0;
  let measurableBins = 0;
  let totalBins = 0;

  for (let t = 0; t < cf; t++) {
    const pc = carrier.spec.power[t];
    const po = outSpec.power[t];
    let framePeak = -Infinity;
    for (let k = 1; k < bins; k++) framePeak = Math.max(framePeak, powerToDb(pc[k]));
    for (let k = 0; k < bins; k++) {
      const measurable = powerToDb(pc[k]) >= framePeak - measFloor;
      if (measurable) measurableBins++;
      totalBins++;
      carrierTotal += pc[k];
      outTotal += po[k];
      predictedTotal += pc[k] * Math.pow(10, gainsDb[t][k] / 10);
      if (donorFillBins[t][k]) {
        gapCarrier += pc[k];
        gapOut += po[k];
        if (measurable) { gapCarrierMeas += pc[k]; gapOutMeas += po[k]; }
      }
      if (unexcitedBins[t][k]) {
        unexcCarrier += pc[k];
        unexcOut += po[k];
        if (gainsDb[t][k] > maxBoostUnexc) maxBoostUnexc = gainsDb[t][k];
      }
    }
  }
  const negligibleShare = 1e-5;
  const gapShare = carrierTotal > 1e-15 ? gapCarrier / carrierTotal : 0;
  return {
    totalEnergyRatioAchieved: carrierTotal > 1e-15 ? outTotal / carrierTotal : null,
    totalEnergyRatioPredicted: carrierTotal > 1e-15 ? predictedTotal / carrierTotal : null,
    gapEnergyShareOfCarrier: gapShare,
    gapEnergyRatioAchieved: gapCarrier > 1e-15 ? gapOut / gapCarrier : null,
    gapEnergyRatioMeasurable: gapCarrierMeas > 1e-15 ? gapOutMeas / gapCarrierMeas : null,
    gapRatioMeaningful: gapShare >= negligibleShare,
    unexcitedEnergyShareOfCarrier: carrierTotal > 1e-15 ? unexcCarrier / carrierTotal : null,
    unexcitedEnergyRatio: unexcCarrier > 1e-15 ? unexcOut / unexcCarrier : null,
    unexcitedRatioMeaningful: carrierTotal > 1e-15 && unexcCarrier / carrierTotal >= negligibleShare,
    maxGainInUnexcitedDb: Number.isFinite(maxBoostUnexc) ? maxBoostUnexc : null,
    measurableBinFraction: totalBins ? measurableBins / totalBins : null,
    note: 'Measured on the STFT-resynthesised signal before loudness matching and makeup gain. Ratios are only reported as meaningful when the region carries a non-negligible share of carrier energy.',
  };
}

// ---------------------------------------------------------------------------
// Loudness contour matching
// ---------------------------------------------------------------------------

function scaleToRms(x, targetRms, maxDb) {
  const r = rms(x);
  if (r < 1e-12 || targetRms < 1e-12) return x;
  const db = Math.max(-maxDb, Math.min(maxDb, linToDb(targetRms / r)));
  const g = dbToLin(db);
  const out = Float32Array.from(x);
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

function matchLoudnessEnvelope(output, target, rate, options) {
  const frameSec = options.loudnessFrameSec;
  const hop = Math.max(1, Math.round((frameSec * rate) / 2));
  const hopSec = hop / rate;
  const fo = frameRms(output, rate, frameSec);
  const ft = frameRms(target, rate, frameSec);
  const n = Math.min(fo.values.length, ft.values.length);
  if (!n) return { out: output, maxGainAppliedDb: 0, mutedFrames: 0, clampedFrames: 0, frames: 0 };
  const gains = new Float64Array(n);
  const maxGain = dbToLin(options.maxMakeupDb);
  const silenceFloor = 1e-6;
  let maxGainAppliedDb = -Infinity;
  let mutedFrames = 0;
  let clampedFrames = 0;
  for (let i = 0; i < n; i++) {
    const o = fo.values[i];
    const tgt = ft.values[i];
    if (o < silenceFloor && tgt >= silenceFloor) { gains[i] = 0; mutedFrames++; continue; }
    if (o < silenceFloor) { gains[i] = 1; continue; }
    let g = tgt / o;
    if (g > maxGain) { g = maxGain; clampedFrames++; }
    gains[i] = g;
    const db = linToDb(g);
    if (db > maxGainAppliedDb) maxGainAppliedDb = db;
  }
  const out = Float32Array.from(output);
  const t0 = fo.times[0];
  for (let i = 0; i < out.length; i++) {
    const idxF = (i / rate - t0) / hopSec;
    let g;
    if (idxF <= 0) g = gains[0];
    else if (idxF >= n - 1) g = gains[n - 1];
    else {
      const i0 = Math.floor(idxF);
      const f = idxF - i0;
      g = gains[i0] * (1 - f) + gains[i0 + 1] * f;
    }
    out[i] *= g;
  }
  return {
    out,
    maxGainAppliedDb: Number.isFinite(maxGainAppliedDb) ? maxGainAppliedDb : 0,
    mutedFrames,
    clampedFrames,
    frames: n,
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n;
  my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  if (sxx < 1e-18 || syy < 1e-18) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function correlationDbSeries(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 4) return null;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = 20 * Math.log10(a[i] + 1e-9);
    y[i] = 20 * Math.log10(b[i] + 1e-9);
  }
  return pearson(x, y);
}

function dynamicRange(x) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < x.length; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; }
  return Number.isFinite(mx - mn) ? mx - mn : 0;
}

function analyseResult(ctx) {
  const {
    options, workRate, fftSize, hop, binHz, hopSec,
    donor, carrier, output, spectralOutput, excitation,
    donorEnv, carrierEnv, outEnv, outEnvRaw, outAmp, outSpec, outLifter,
    donorShapes, donorShapeAtCarrier, targetShapeBand,
    donorObsBins, gainsDb,
    carrierExcitation, unexcitedBins, bypassedFrames, coverage, stats,
    loudnessInfo, makeupDb, peakGuardDb, preGainRms, guardMuted,
  } = ctx;

  const cf = carrier.spec.frames;
  const bins = carrier.spec.bins;
  const nb = donor.env.centres.length;
  const threshold = options.confidenceThreshold;

  // --- Spectral-shape fit at band level, observation-restricted -------------
  // Output band shape is taken relative to the output's own reference over the
  // observed bands; the target is the gap-resolved donor shape. Both are
  // shapes, so absolute level differences do not score.
  const outObs = new Float32Array(cf);
  let errSum = 0;
  let baseErrSum = 0;
  let scoredBands = 0;
  let totalBands = 0;
  for (let t = 0; t < cf; t++) {
    const obs = donorObsBins[t];
    const weights = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const [k0, k1] = donor.env.bandRanges[b];
      let m = 0;
      for (let k = k0; k <= k1; k++) m = Math.max(m, obs[k]);
      weights[b] = m >= threshold ? 1 : 0;
    }
    const outRef = bandReferenceDb(outEnv.db[t], weights, 0.5);
    outObs[t] = outRef;
    for (let b = 0; b < nb; b++) {
      const [k0, k1] = donor.env.bandRanges[b];
      totalBands++;
      let excMax = 0;
      for (let k = k0; k <= k1; k++) excMax = Math.max(excMax, carrierExcitation[t][k]);
      if (weights[b] && excMax >= 0.25) {
        const outShape = outEnv.db[t][b] - outRef;
        const target = targetShapeBand[t][b];
        errSum += Math.abs(outShape - target);
        // Baseline = identity (donor band shape replaced by carrier band shape).
        baseErrSum += Math.abs(outShape - (carrierEnv.db[t][b] - bandReferenceDb(carrierEnv.db[t], weights, 0.5)));
        scoredBands++;
      }
    }
  }

  // --- Trend transfer on a band both sources actually support ---------------
  // A band only qualifies if the carrier can excite it *and* the donor observes
  // it for most of the time. A donor-gap band (e.g. a band-limited donor's top
  // octave) would otherwise be scored on the output's own noise floor.
  const maskBands = new Uint8Array(nb);
  for (let b = 0; b < nb; b++) {
    let present = 0;
    for (let t = 0; t < cf; t++) {
      const [k0, k1] = donor.env.bandRanges[b];
      let m = 0;
      for (let k = k0; k <= k1; k++) m = Math.max(m, carrierExcitation[t][k]);
      if (m >= 0.5) present++;
    }
    let obsFrames = 0;
    for (let t = 0; t < cf; t++) {
      const [k0, k1] = donor.env.bandRanges[b];
      let m = 0;
      for (let k = k0; k <= k1; k++) m = Math.max(m, donorObsBins[t][k]);
      if (m >= 0.5) obsFrames++;
    }
    if (present > cf * 0.2 && obsFrames > cf * 0.5) {
      // Require the band to carry real donor dynamics, not a floor wobble.
      let mean = 0;
      for (let t = 0; t < cf; t++) mean += donorShapeAtCarrier[t][b];
      mean /= cf;
      if (mean > -30) maskBands[b] = 1;
    }
  }
  let band = -1;
  let bestVar = -Infinity;
  for (let b = 0; b < nb; b++) {
    if (!maskBands[b]) continue;
    let mean = 0;
    for (let t = 0; t < cf; t++) mean += donorShapeAtCarrier[t][b];
    mean /= cf;
    let v = 0;
    for (let t = 0; t < cf; t++) { const d = donorShapeAtCarrier[t][b] - mean; v += d * d; }
    if (v > bestVar) { bestVar = v; band = b; }
  }
  if (band < 0) band = Math.floor(nb / 2);

  const donorTrace = new Float32Array(cf);
  const outTrace = new Float32Array(cf);
  const carrierTrace = new Float32Array(cf);
  for (let t = 0; t < cf; t++) {
    donorTrace[t] = donorShapeAtCarrier[t][band];
    outTrace[t] = outEnv.db[t][band] - outObs[t];
    const carRef = bandReferenceDb(carrierEnv.db[t], new Float32Array(nb).fill(1), 0);
    carrierTrace[t] = carrierEnv.db[t][band] - carRef;
  }
  const trendCorr = {
    bandHz: donor.env.centres[band],
    bandIndex: band,
    outputVsDonor: pearson(outTrace, donorTrace),
    outputVsCarrier: pearson(outTrace, carrierTrace),
    donorDynamicDb: dynamicRange(donorTrace),
    carrierDynamicDb: dynamicRange(carrierTrace),
    maskedBandFraction: Array.from(maskBands).filter(Boolean).length / nb,
    // Mean-removed dB traces at the evidence band, for the UI to plot.
    series: {
      times: Float32Array.from({ length: cf }, (_, t) =>
        (t * hop + fftSize / 2 - carrier.spec.pad) / workRate),
      donor: Float32Array.from(donorTrace),
      carrier: Float32Array.from(carrierTrace),
      output: Float32Array.from(outTrace),
    },
  };

  const ampCorr = {
    outputVsCarrier: correlationDbSeries(outAmp.values, carrier.amp.values),
    outputVsDonor: correlationDbSeries(outAmp.values, donor.amp.values),
    carrierVsDonor: correlationDbSeries(carrier.amp.values, donor.amp.values),
  };

  const outputPeriod = estimatePeriod(output, workRate);
  const excitationPeriod = estimatePeriod(excitation, workRate);
  const spectralPeriod = estimatePeriod(spectralOutput, workRate);
  const outRmsValue = rms(output);

  const metrics = {
    durationSec: output.length / workRate,
    workRate,
    fftSize,
    hop,
    binHz,
    coverage: {
      frameFraction: cf ? stats.covered / cf : 0,
      heldFraction: cf ? stats.held / cf : 0,
      bypassFraction: cf ? stats.bypassed / cf : 0,
      donorGapBinFraction: stats.binTotal ? stats.donorGapBins / stats.binTotal : 0,
      unexcitedBinFraction: stats.binTotal ? stats.unexcitedBins / stats.binTotal : 0,
      refusedBoostBinFraction: stats.binTotal ? stats.refusedBoostBins / stats.binTotal : 0,
    },
    spectralFit: {
      meanAbsDb: scoredBands ? errSum / scoredBands : null,
      identityBaselineDb: scoredBands ? baseErrSum / scoredBands : null,
      bandsScored: scoredBands,
      bandsTotal: totalBands,
    },
    trendCorr,
    ampCorr,
    periods: {
      donor: donor.period,
      carrier: carrier.period,
      output: outputPeriod,
      excitation: excitationPeriod,
      spectralStageOutput: spectralPeriod,
    },
    envelope: {
      donorLifterMs: (donor.lifterSamples / workRate) * 1000,
      carrierLifterMs: (carrier.lifterSamples / workRate) * 1000,
      outputLifterMs: (outLifter / workRate) * 1000,
      method: 'cepstral',
    },
    energy: {
      carrierRms: carrier.rms,
      outputRms: outRmsValue,
      outputOverCarrierRms: carrier.rms > 1e-12 ? outRmsValue / carrier.rms : null,
      makeupDb,
      peakGuardDb,
      outputPeak: peak(output),
      carrierPeak: carrier.peak,
      guardMuted,
      preGainRms,
    },
    gainRangeDb: {
      min: Number.isFinite(stats.gainMin) ? stats.gainMin : null,
      max: Number.isFinite(stats.gainMax) ? stats.gainMax : null,
    },
    resample: {
      donor: { inputRate: donor.inputRate, workRate, applied: donor.inputRate !== workRate, rmsRatio: donor.resampleGain },
      carrier: { inputRate: carrier.inputRate, workRate, applied: carrier.inputRate !== workRate, rmsRatio: carrier.resampleGain },
    },
    loudness: loudnessInfo ? {
      maxGainAppliedDb: loudnessInfo.maxGainAppliedDb,
      mutedFrames: loudnessInfo.mutedFrames,
      clampedFrames: loudnessInfo.clampedFrames,
      frames: loudnessInfo.frames,
      enabled: options.preserveCarrierLoudness,
    } : { enabled: false },
    scaleNotes: {
      spectralEnvelope: 'dB re. full-scale sinusoid peak bin (0 dB)',
      amplitudeEnvelope: 'dBFS broadband frame RMS',
      gain: 'relative dB per FFT bin, envelope references removed',
      notASeparation: true,
      excitationModel: 'carrier magnitude / its own cepstral spectral envelope',
    },
  };
  return { metrics };
}

// ---------------------------------------------------------------------------
// Render images
// ---------------------------------------------------------------------------

function buildImages({ donor, carrier, outSpec, outEnv, outAmp, donorEnv, donorShapes, carrierEnv, gainsDb, targetShapeBins, donorObsBins, donorFillBins, carrierExcitation, unexcitedBins, bypassedFrames, spectralOutput, workRate }) {
  const nT = 260;
  const nB = 140;
  const nb = donorEnv.centres.length;

  const sampleBand = (arrOfFrames, nT_, nB_) => {
    const frames = arrOfFrames.length;
    const out = new Float32Array(nT_ * nB_);
    for (let ti = 0; ti < nT_; ti++) {
      const src = frames > 1 ? Math.round((ti / (nT_ - 1)) * (frames - 1)) : 0;
      const frame = arrOfFrames[src];
      for (let bi = 0; bi < nB_; bi++) {
        const pos = (bi / (nB_ - 1)) * (nb - 1);
        const i0 = Math.floor(pos);
        const i1 = Math.min(nb - 1, i0 + 1);
        const f = pos - i0;
        out[ti * nB_ + bi] = frame[i0] + (frame[i1] - frame[i0]) * f;
      }
    }
    return out;
  };

  const freqGrid = new Float64Array(nB);
  const fMin = donorEnv.centres[0];
  const fMax = donorEnv.centres[nb - 1];
  for (let i = 0; i < nB; i++) freqGrid[i] = fMin * Math.pow(fMax / fMin, i / (nB - 1));

  // Every panel uses the same log-frequency display axis, so an FFT-bin-indexed
  // map and a band-indexed envelope line up feature-for-feature.
  const binForRow = (bi, nB_, fftSize, sampleRate) => {
    const f = fMin * Math.pow(fMax / fMin, bi / (nB_ - 1));
    return Math.max(0, Math.min(fftSize / 2, f / (sampleRate / fftSize)));
  };

  const sampleBins = (arr, nT_, nB_, fftSize, sampleRate) => {
    const frames = arr.length;
    const bins = fftSize / 2 + 1;
    const out = new Float32Array(nT_ * nB_);
    for (let ti = 0; ti < nT_; ti++) {
      const src = frames > 1 ? Math.round((ti / (nT_ - 1)) * (frames - 1)) : 0;
      const frame = arr[src];
      for (let bi = 0; bi < nB_; bi++) {
        const kf = binForRow(bi, nB_, fftSize, sampleRate);
        const k0 = Math.min(bins - 1, Math.floor(kf));
        const k1 = Math.min(bins - 1, k0 + 1);
        const f = kf - k0;
        out[ti * nB_ + bi] = frame[k0] + (frame[k1] - frame[k0]) * f;
      }
    }
    return out;
  };

  const spectrogramOf = (spec, nT_, nB_) => {
    const frames = spec.frames;
    const bins = spec.bins;
    const fftSize = spec.fftSize;
    const sampleRate = spec.sampleRate;
    const data = new Float32Array(nT_ * nB_);
    const raw = new Float32Array(nT_ * nB_);
    let maxDb = -Infinity;
    for (let ti = 0; ti < nT_; ti++) {
      const src = frames > 1 ? Math.round((ti / (nT_ - 1)) * (frames - 1)) : 0;
      for (let bi = 0; bi < nB_; bi++) {
        const kf = binForRow(bi, nB_, fftSize, sampleRate);
        const k0 = Math.min(bins - 1, Math.floor(kf));
        const k1 = Math.min(bins - 1, k0 + 1);
        const f = kf - k0;
        const p = spec.power[src][k0] * (1 - f) + spec.power[src][k1] * f;
        const d = powerToDb(p);
        raw[ti * nB_ + bi] = d;
        if (d > maxDb) maxDb = d;
      }
    }
    const floor = maxDb - 85;
    for (let i = 0; i < raw.length; i++) {
      data[i] = Math.max(0, Math.min(1, (raw[i] - floor) / (maxDb - floor + 1e-9)));
    }
    return { data, width: nT_, height: nB_, maxDb, floorDb: floor };
  };

  const spectralSpec = carrier.stft.analyze(spectralOutput);

  return {
    width: nT,
    height: nB,
    freqGrid,
    donorEnv: sampleBand(donorEnv.db, nT, nB),
    donorShape: sampleBand(donorShapes, nT, nB),
    carrierEnv: sampleBand(carrierEnv.db, nT, nB),
    outputEnv: sampleBand(outEnv.db, nT, nB),
    targetShape: sampleBins(targetShapeBins, nT, nB, outSpec.fftSize, workRate),
    gainDb: sampleBins(gainsDb, nT, nB, outSpec.fftSize, workRate),
    donorConfidence: sampleBins(donorObsBins, nT, nB, outSpec.fftSize, workRate),
    donorGapFill: sampleBins(donorFillBins, nT, nB, outSpec.fftSize, workRate),
    excitationSupport: sampleBins(carrierExcitation, nT, nB, outSpec.fftSize, workRate),
    unexcited: sampleBins(unexcitedBins, nT, nB, outSpec.fftSize, workRate),
    bypassedFrames: Array.from(bypassedFrames),
    donorSpectrogram: spectrogramOf(donor.spec, 300, 120),
    carrierSpectrogram: spectrogramOf(carrier.spec, 300, 120),
    spectralSpectrogram: spectrogramOf(spectralSpec, 300, 120),
    outputSpectrogram: spectrogramOf(outSpec, 300, 120),
    amp: {
      donor: { times: donor.amp.times, values: donor.amp.values },
      carrier: { times: carrier.amp.times, values: carrier.amp.values },
      output: { times: outAmp.times, values: outAmp.values },
    },
  };
}
