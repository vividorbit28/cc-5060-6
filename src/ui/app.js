// UI wiring for the cross-source shaper. All DSP runs locally in the page using
// the same ES modules as the tests; no audio leaves the browser.

import {
  resonantTone,
  generatePulseTrain,
  generateNoise,
  fadeInOut,
} from '../dsp/sources.js';
import { crossSynthesize } from '../dsp/engine.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Voice presets
// ---------------------------------------------------------------------------

const PRESET_RATE = 44100;

function donorSamples(preset, seconds, rate = PRESET_RATE) {
  switch (preset) {
    case 'sweepingVowel':
      return resonantTone({
        rate, durationSec: seconds, f0: 120, amplitude: 0.62, pulseWidthMs: 1.2,
        formants: [
          { freq: 520, bw: 85, gain: 1 },
          { freq: 1450, bw: 130, gain: 0.62 },
          { freq: 2850, bw: 210, gain: 0.34 },
          { freq: 5200, bw: 420, gain: 0.14 },
        ],
        formantMod: { rateHz: 0.42, depthOct: 0.26 },
        tremoloHz: 0.0001, tremoloDepth: 0,
      });
    case 'staticNasal':
      return resonantTone({
        rate, durationSec: seconds, f0: 110, amplitude: 0.6,
        formants: [
          { freq: 320, bw: 60, gain: 1 },
          { freq: 1150, bw: 110, gain: 0.5 },
          { freq: 2400, bw: 190, gain: 0.18 },
        ],
      });
    case 'brightBandLimited': {
      // Only the low two formants: the top octaves are genuinely unobserved,
      // which exercises the gap policy.
      return resonantTone({
        rate, durationSec: seconds, f0: 140, amplitude: 0.6,
        formants: [
          { freq: 420, bw: 70, gain: 1 },
          { freq: 880, bw: 90, gain: 0.7 },
        ],
        formantMod: { rateHz: 0.5, depthOct: 0.12 },
      });
    }
    case 'noiseCloud':
      return resonantTone({
        rate, durationSec: seconds, f0: 120, amplitude: 0.5, source: 'noise',
        noiseColor: 'pink', seed: 7,
        formants: [
          { freq: 700, bw: 180, gain: 1 },
          { freq: 2100, bw: 320, gain: 0.6 },
          { freq: 3800, bw: 500, gain: 0.3 },
        ],
        formantMod: { rateHz: 0.35, depthOct: 0.22 },
      });
    default:
      throw new Error(`unknown donor preset ${preset}`);
  }
}

function carrierSamples(preset, seconds, f0, rate = PRESET_RATE) {
  switch (preset) {
    case 'pulse220': return generatePulseTrain({ rate, durationSec: seconds, f0: f0 || 220, pulseWidthMs: 2, amplitude: 0.7 });
    case 'pulse90': return generatePulseTrain({ rate, durationSec: seconds, f0: f0 || 90, pulseWidthMs: 2.5, amplitude: 0.7 });
    case 'pulse330': return generatePulseTrain({ rate, durationSec: seconds, f0: f0 || 330, pulseWidthMs: 1.6, amplitude: 0.7 });
    case 'whiteNoise': return generateNoise({ rate, durationSec: seconds, color: 'white', seed: 3, amplitude: 0.45 });
    case 'pinkNoise': return generateNoise({ rate, durationSec: seconds, color: 'pink', seed: 4, amplitude: 0.5 });
    default: throw new Error(`unknown carrier preset ${preset}`);
  }
}

// ---------------------------------------------------------------------------
// File loading (decoded via Web Audio, mixed to mono, resampled by the engine)
// ---------------------------------------------------------------------------

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const fileCache = { donor: null, carrier: null };

async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  const buf = await audioCtx.decodeAudioData(bytes.slice(0));
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const scale = 1 / Math.max(1, buf.numberOfChannels);
  for (let i = 0; i < n; i++) out[i] *= scale;
  return { sampleRate: buf.sampleRate, samples: fadeInOut(out, buf.sampleRate, 5) };
}

$('donorFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  fileCache.donor = await decodeFile(f);
  $('donorPreset').value = 'file';
  $('donorInfo').textContent = `${f.name} · ${fileCache.donor.samples.length} samples @ ${fileCache.donor.sampleRate} Hz`;
});

$('carrierFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  fileCache.carrier = await decodeFile(f);
  $('carrierPreset').value = 'file';
  $('carrierInfo').textContent = `${f.name} · ${fileCache.carrier.samples.length} samples @ ${fileCache.carrier.sampleRate} Hz`;
});

function buildDonor(opts) {
  if ($('donorPreset').value === 'file') {
    if (!fileCache.donor) throw new Error('choose a donor audio file first');
    return fileCache.donor;
  }
  const seconds = Math.max(0.25, Number(opts.donorDuration) || 4);
  return { sampleRate: PRESET_RATE, samples: donorSamples($('donorPreset').value, seconds) };
}

function buildCarrier(opts) {
  if ($('carrierPreset').value === 'file') {
    if (!fileCache.carrier) throw new Error('choose a carrier audio file first');
    return fileCache.carrier;
  }
  const seconds = Math.max(0.25, Number(opts.carrierDuration) || 4);
  return {
    sampleRate: PRESET_RATE,
    samples: carrierSamples($('carrierPreset').value, seconds, Number($('carrierF0').value)),
  };
}

// ---------------------------------------------------------------------------
// Option collection
// ---------------------------------------------------------------------------

function readOptions() {
  const fftSize = Number($('fftSize').value);
  const overlap = Number($('overlap').value);
  const fMaxRaw = $('fMax').value.trim();
  const outDurRaw = $('outputDurationSec').value.trim();
  const workRateRaw = $('workRate').value;
  return {
    fftSize,
    hop: Math.max(1, Math.round(fftSize / overlap)),
    bandsPerOctave: Number($('bandsPerOctave').value),
    fMin: Number($('fMin').value) || 60,
    fMax: fMaxRaw ? Number(fMaxRaw) : null,
    envSmoothSec: Number($('envSmoothSec').value),
    noiseFloorDb: Number($('noiseFloorDb').value),
    confidenceThreshold: Number($('confidenceThreshold').value),
    timeMap: $('timeMap').value,
    timeOffsetSec: Number($('timeOffsetSec').value) || 0,
    timeGapMode: $('timeGapMode').value,
    freqGapMode: $('freqGapMode').value,
    extrapolateMaxRiseDb: Number($('extrapolateMaxRiseDb').value),
    extrapolateMaxFallDb: Number($('extrapolateMaxFallDb').value),
    maxBoostDb: Number($('maxBoostDb').value),
    maxCutDb: Number($('maxCutDb').value),
    excitationRangeDb: Number($('excitationRangeDb').value),
    excitationFloor: Number($('excitationFloor').value),
    preserveCarrierLoudness: $('preserveCarrierLoudness').checked,
    outputGainMode: $('outputGainMode').value,
    outputGainDb: Number($('outputGainDb').value) || 0,
    peakCeiling: Number($('peakCeiling').value),
    outputDurationSec: outDurRaw ? Number(outDurRaw) : null,
    workRate: workRateRaw ? Number(workRateRaw) : null,
  };
}

// Keep live outputs in sync.
for (const [id, out, fix] of [
  ['envSmoothSec', 'envSmoothOut', 2],
  ['noiseFloorDb', 'noiseFloorOut', 0],
  ['confidenceThreshold', 'confidenceOut', 2],
]) {
  const el = $(id);
  const o = $(out);
  const sync = () => { o.textContent = Number(el.value).toFixed(fix); };
  el.addEventListener('input', sync);
  sync();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let last = null;

function setStatus(msg, cls = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

async function run() {
  let donor, carrier, opts;
  try {
    opts = readOptions();
    donor = buildDonor(opts);
    carrier = buildCarrier(opts);
  } catch (e) {
    setStatus(e.message, 'err');
    return;
  }
  $('run').disabled = true;
  setStatus('analysing…', 'busy');
  // Let the browser paint the busy state before the synchronous DSP run.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    const t0 = performance.now();
    const result = crossSynthesize(donor, carrier, opts);
    const dt = performance.now() - t0;
    last = result;
    $('donorInfo').textContent = `${donor.samples.length} samples @ ${donor.sampleRate} Hz`;
    $('carrierInfo').textContent = `${carrier.samples.length} samples @ ${carrier.sampleRate} Hz`;
    setStatus(`done in ${dt.toFixed(0)} ms · work rate ${result.workRate} Hz · ${result.output.length} samples`);
    drawAll(result);
    renderReport(result);
  } catch (e) {
    console.error(e);
    setStatus(`error: ${e.message}`, 'err');
  } finally {
    $('run').disabled = false;
  }
}

$('run').addEventListener('click', run);

$('defaults').addEventListener('click', () => {
  for (const [id, val] of Object.entries({
    fftSize: '2048', overlap: '4', bandsPerOctave: '12', fMin: '60', fMax: '8000',
    envSmoothSec: '0.15', noiseFloorDb: '90', confidenceThreshold: '0.5',
    timeMap: 'stretch', timeOffsetSec: '0', timeGapMode: 'hold', outputDurationSec: '',
    workRate: '', freqGapMode: 'extrapolate', extrapolateMaxRiseDb: '6',
    extrapolateMaxFallDb: '18', maxBoostDb: '18', maxCutDb: '60',
    excitationRangeDb: '70', excitationFloor: '0.10', outputGainMode: 'carrier-rms',
    outputGainDb: '0', peakCeiling: '0.98', donorPreset: 'sweepingVowel',
    carrierPreset: 'pulse220', donorDuration: '4', carrierDuration: '4', carrierF0: '220',
  })) {
    const el = $(id);
    if (el) el.value = val;
  }
  $('preserveCarrierLoudness').checked = true;
  $('envSmoothOut').textContent = '0.15';
  $('noiseFloorOut').textContent = '90';
  $('confidenceOut').textContent = '0.50';
});

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

let sourceNode = null;
let raf = 0;

function stopPlayback() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch { /* already stopped */ }
    sourceNode = null;
  }
  cancelAnimationFrame(raf);
  $('nowPlaying').textContent = 'nothing playing';
  $('progress').value = 0;
}

function playSamples(samples, rate, label) {
  stopPlayback();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  if (!samples || !samples.length) { setStatus('nothing to play', 'err'); return; }
  const buffer = audioCtx.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const node = audioCtx.createBufferSource();
  node.buffer = buffer;
  node.connect(audioCtx.destination);
  const start = audioCtx.currentTime + 0.02;
  node.start(start);
  sourceNode = node;
  $('nowPlaying').textContent = `${label} · ${samples.length} samples @ ${rate} Hz`;
  const tick = () => {
    if (sourceNode !== node) return;
    const p = (audioCtx.currentTime - start) / buffer.duration;
    $('progress').value = Math.min(1, Math.max(0, p));
    if (p >= 1) { stopPlayback(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  node.onended = () => { if (sourceNode === node) stopPlayback(); };
}

document.querySelectorAll('[data-solo]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!last) { setStatus('run the analysis first', 'err'); return; }
    const which = btn.dataset.solo;
    if (which === 'donor') playSamples(last.donor.samples, last.workRate, 'donor');
    else if (which === 'carrier') playSamples(last.carrier.samples, last.workRate, 'carrier');
    else if (which === 'excitation') playSamples(last.excitation, last.workRate, 'excitation proxy');
    else if (which === 'spectral') playSamples(last.spectralOutput, last.workRate, 'spectral stage');
    else if (which === 'output') playSamples(last.output, last.workRate, 'output');
  });
});

$('stop').addEventListener('click', stopPlayback);

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function prepCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(2, Math.round(rect.width * dpr));
  const h = Math.max(2, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function heatColour(v) {
  // Dark blue -> cyan -> yellow -> white.
  const t = Math.min(1, Math.max(0, v));
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.6 * t - 0.45)));
  const g = Math.round(255 * Math.min(1, Math.max(0, 1.5 * t - 0.1)));
  const b = Math.round(255 * Math.min(1, Math.max(0, 0.35 + 1.1 * t - 1.05 * t * t)));
  return [r, g, b];
}

function drawHeat(canvas, data, w, h, lo, hi, flip = true, opts = {}) {
  // `data` is time-major: index = time * h + band (so the per-row stride is h).
  const { ctx, w: cw, h: ch } = prepCanvas(canvas);
  const img = ctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    const by = Math.floor((y / ch) * h);
    const b = flip ? h - 1 - by : by;
    for (let x = 0; x < cw; x++) {
      const t = Math.min(w - 1, Math.floor((x / cw) * w));
      const v = data[t * h + b];
      const [r, g, bl] = opts.diverging
        ? divergingColour(v, lo, hi)
        : heatColour((v - lo) / (hi - lo || 1));
      const i = (y * cw + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = bl; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (opts.label) {
    ctx.font = `${Math.round(10 * (window.devicePixelRatio || 1))}px ui-sans-serif`;
    ctx.fillStyle = 'rgba(230,235,245,0.85)';
    ctx.fillText(opts.label, 6, 13 * (window.devicePixelRatio || 1));
  }
}

function divergingColour(v, lo, hi) {
  const t = Math.min(1, Math.max(-1, v / (Math.abs(hi) || 1)));
  if (t >= 0) {
    return [Math.round(90 + 165 * t), Math.round(140 + 60 * t), Math.round(240 - 120 * t)];
  }
  const a = -t;
  return [Math.round(90 - 40 * a), Math.round(140 - 40 * a), Math.round(240 - 20 * a)];
}

function drawMask(canvas, imgs) {
  // Time-major data: index = time * h + band.
  const { ctx, w: cw, h: ch } = prepCanvas(canvas);
  const { width: w, height: h, donorConfidence, donorGapFill, excitationSupport, unexcited } = imgs;
  const img = ctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    const b = h - 1 - Math.floor((y / ch) * h);
    for (let x = 0; x < cw; x++) {
      const t = Math.min(w - 1, Math.floor((x / cw) * w));
      const i0 = t * h + b;
      const observed = donorConfidence ? donorConfidence[i0] >= 0.5 : true;
      const filled = donorGapFill ? donorGapFill[i0] > 0.5 : false;
      const sup = excitationSupport[i0];
      const unex = unexcited[i0];
      // Red: donor band unobserved (not evidence) — brighter where filled.
      // Green: carrier excitation support. Blue: carrier unexcited. Dark: both.
      const r = Math.round(!observed ? (filled ? 235 : 110) : 0);
      const g = Math.round(215 * sup * (observed ? 1 : 0.35));
      const bl = Math.round(235 * unex * (observed ? 1 : 0.3));
      const i = (y * cw + x) * 4;
      img.data[i] = Math.min(255, r);
      img.data[i + 1] = Math.min(255, g);
      img.data[i + 2] = Math.min(255, bl);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawSeries(canvas, series, opts = {}) {
  const { ctx, w, h } = prepCanvas(canvas);
  const pad = { l: 34, r: 8, t: 10, b: 18 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  ctx.strokeStyle = '#2a2f3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, iw, ih);

  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    for (const v of s.values) { if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  }
  if (opts.lo !== undefined) lo = opts.lo;
  if (opts.hi !== undefined) hi = opts.hi;
  if (!(hi > lo)) { hi = lo + 1; }
  const xOf = (t) => pad.l + ((t - opts.t0) / (opts.t1 - opts.t0 || 1)) * iw;
  const yOf = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

  ctx.font = `${Math.round(10 * (window.devicePixelRatio || 1))}px ui-sans-serif`;
  ctx.fillStyle = '#8b93a3';
  ctx.fillText(`${hi.toFixed(0)}`, 2, pad.t + 8);
  ctx.fillText(`${lo.toFixed(0)}`, 2, pad.t + ih);
  ctx.fillText('0 s', pad.l, h - 4);
  const endLabel = `${opts.t1.toFixed(2)} s`;
  ctx.fillText(endLabel, pad.l + iw - ctx.measureText(endLabel).width, h - 4);

  for (const s of series) {
    ctx.strokeStyle = s.colour;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let started = false;
    const times = s.times ?? opts.times;
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      const x = xOf(times[i]);
      const y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function drawAll(r) {
  const imgs = r.images;

  // Shared dB range across the three envelope panels so levels are comparable.
  let lo = Infinity, hi = -Infinity;
  for (const key of ['donorEnv', 'carrierEnv', 'outputEnv']) {
    for (const v of imgs[key]) { if (Number.isFinite(v) && v > -100) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  }
  if (!(hi > lo)) { lo = -80; hi = 0; }

  drawHeat($('canvDonorEnv'), imgs.donorEnv, imgs.width, imgs.height, lo, hi, true, { label: `${hi.toFixed(0)} → ${lo.toFixed(0)} dB` });
  drawHeat($('canvCarrierEnv'), imgs.carrierEnv, imgs.width, imgs.height, lo, hi, true, { label: `${hi.toFixed(0)} → ${lo.toFixed(0)} dB` });
  drawHeat($('canvOutputEnv'), imgs.outputEnv, imgs.width, imgs.height, lo, hi, true, { label: `${hi.toFixed(0)} → ${lo.toFixed(0)} dB` });

  let gmax = 12;
  for (const v of imgs.gainDb) if (Number.isFinite(v)) gmax = Math.max(gmax, Math.abs(v));
  drawHeat($('canvGain'), imgs.gainDb, imgs.width, imgs.height, -gmax, gmax, true, {
    diverging: true, label: `+${gmax.toFixed(0)} / −${gmax.toFixed(0)} dB`,
  });
  drawMask($('canvMasks'), imgs);

  const tr = r.metrics.trendCorr.series;
  drawSeries($('canvTrend'), [
    { values: tr.donor, colour: '#5aa9ff' },
    { values: tr.carrier, colour: '#8b93a3' },
    { values: tr.output, colour: '#58c48a' },
  ], { times: tr.times, t0: tr.times[0] ?? 0, t1: tr.times[tr.times.length - 1] ?? 1 });

  const specOpts = { label: '' };
  drawHeat($('canvDonorSpec'), imgs.donorSpectrogram.data, imgs.donorSpectrogram.width, imgs.donorSpectrogram.height, 0, 1, true, specOpts);
  drawHeat($('canvCarrierSpec'), imgs.carrierSpectrogram.data, imgs.carrierSpectrogram.width, imgs.carrierSpectrogram.height, 0, 1, true, specOpts);
  drawHeat($('canvSpectralSpec'), imgs.spectralSpectrogram.data, imgs.spectralSpectrogram.width, imgs.spectralSpectrogram.height, 0, 1, true, specOpts);
  drawHeat($('canvOutputSpec'), imgs.outputSpectrogram.data, imgs.outputSpectrogram.width, imgs.outputSpectrogram.height, 0, 1, true, specOpts);

  const amp = imgs.amp;
  const db = (vals) => Float32Array.from(vals, (v) => 20 * Math.log10(v + 1e-9));
  const t1 = Math.max(
    amp.donor.times[amp.donor.times.length - 1] ?? 0,
    amp.carrier.times[amp.carrier.times.length - 1] ?? 0,
    amp.output.times[amp.output.times.length - 1] ?? 0,
  );
  // The three recordings have different lengths; each keeps its own time base.
  const ampSeries = [
    { values: db(amp.donor.values), colour: '#5aa9ff', times: amp.donor.times },
    { values: db(amp.carrier.values), colour: '#ffab5a', times: amp.carrier.times },
    { values: db(amp.output.values), colour: '#58c48a', times: amp.output.times },
  ];
  // Auto-range with a little headroom so a steady signal does not sit at 0 dB
  // and a quiet one does not vanish; clamp to a sensible dB window.
  let ampLo = Infinity, ampHi = -Infinity;
  for (const s of ampSeries) for (const v of s.values) {
    if (Number.isFinite(v)) { ampLo = Math.min(ampLo, v); ampHi = Math.max(ampHi, v); }
  }
  if (!Number.isFinite(ampLo)) { ampLo = -90; ampHi = 0; }
  ampLo = Math.max(-110, Math.floor((ampLo - 3) / 5) * 5);
  ampHi = Math.min(0, Math.ceil((ampHi + 3) / 5) * 5);
  if (ampHi - ampLo < 20) ampHi = ampLo + 20;
  drawSeries($('canvAmp'), ampSeries, { times: amp.output.times, t0: 0, t1: t1 || 1, lo: ampLo, hi: ampHi });
}

// Redraw on resize (debounced) to keep canvases sharp.
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (last) drawAll(last); }, 150);
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(x, digits = 2, suffix = '') {
  if (x === null || x === undefined || !Number.isFinite(Number(x))) return '—';
  return `${Number(x).toFixed(digits)}${suffix}`;
}

function corrClass(v, good = 0.8) {
  if (v === null) return '';
  return v >= good ? 'ok' : v >= 0.4 ? 'warn' : 'bad';
}

function renderReport(r) {
  const m = r.metrics;
  const e = m.energy;
  const audit = r.spectralAudit;
  const fit = m.spectralFit;
  const tc = m.trendCorr;
  const p = m.periods;
  const a = m.ampCorr;

  const fitWorseThanIdentity = fit.meanAbsDb !== null && fit.identityBaselineDb !== null &&
    fit.meanAbsDb >= fit.identityBaselineDb;

  const rows = [
    ['Spectral-envelope trend correlation (output vs donor)', `${fmt(tc.outputVsDonor)} <span class="hint">@ ${fmt(tc.bandHz, 0)} Hz</span>`, corrClass(tc.outputVsDonor)],
    ['…output vs carrier', fmt(tc.outputVsCarrier), corrClass(tc.outputVsCarrier, 0.4)],
    ['Donor / carrier dynamics at that band', `${fmt(tc.donorDynamicDb, 1)} / ${fmt(tc.carrierDynamicDb, 1)} dB`, ''],
    ['Amplitude-envelope correlation (output vs carrier)', fmt(a.outputVsCarrier), corrClass(a.outputVsCarrier)],
    ['…output vs donor', fmt(a.outputVsDonor), ''],
    ['Excitation period — donor / carrier / output', `${fmt(p.donor.hz, 1)} / ${fmt(p.carrier.hz, 1)} / ${fmt(p.output.hz, 1)} Hz`, ''],
    ['Periodic? donor / carrier / output', `${p.donor.periodic} / ${p.carrier.periodic} / ${p.output.periodic}`, ''],
    ['Spectral fit (mean |dB| error)', fmt(fit.meanAbsDb, 2, ' dB'), ''],
    ['Identity baseline (fit if nothing moved)', fmt(fit.identityBaselineDb, 2, ' dB'), ''],
    ['Fit vs identity', fit.meanAbsDb === null ? '—' : (fitWorseThanIdentity ? 'no better than identity' : 'better than identity'), fitWorseThanIdentity ? 'warn' : 'ok'],
    ['Gain range', `${fmt(m.gainRangeDb.min, 1)} … ${fmt(m.gainRangeDb.max, 1)} dB`, ''],
    ['Gap policy — frequency / time', `${r.options.freqGapMode} / ${r.options.timeGapMode}`, ''],
    ['Time map / offset', `${r.options.timeMap} / ${fmt(r.options.timeOffsetSec, 2)} s`, ''],
    ['Coverage — frames covered / held / bypassed', `${fmt(m.coverage.frameFraction * 100, 0)}% / ${fmt(m.coverage.heldFraction * 100, 0)}% / ${fmt(m.coverage.bypassFraction * 100, 0)}%`, ''],
    ['Donor-unobserved (gap) bins filled', fmt(m.coverage.donorGapBinFraction * 100, 1, '%'), ''],
    ['Unexcited bins / refused boosts', `${fmt(m.coverage.unexcitedBinFraction * 100, 1)}% / ${fmt(m.coverage.refusedBoostBinFraction * 100, 1)}%`, ''],
    ['Resampled? donor / carrier', `${m.resample.donor.applied} / ${m.resample.carrier.applied}`, ''],
    ['Resample RMS ratio donor / carrier', `${fmt(m.resample.donor.rmsRatio, 3)} / ${fmt(m.resample.carrier.rmsRatio, 3)}`, ''],
    ['Output/carrier RMS', fmt(e.outputOverCarrierRms, 3), ''],
    ['Makeup gain / peak guard', `${fmt(e.makeupDb, 2)} / ${fmt(e.peakGuardDb, 2)} dB`, ''],
    ['Loudness contour: max gain / muted / clamped frames', m.loudness.enabled ? `${fmt(m.loudness.maxGainAppliedDb, 1)} dB / ${m.loudness.mutedFrames} / ${m.loudness.clampedFrames}` : 'disabled', ''],
  ];

  const auditRows = [
    ['Total energy ratio achieved (spectral stage)', fmt(audit.totalEnergyRatioAchieved, 3), ''],
    ['…predicted from gains', fmt(audit.totalEnergyRatioPredicted, 3), ''],
    ['Gap energy ratio (achieved / measurable)', `${fmt(audit.gapEnergyRatioAchieved, 2)} / ${fmt(audit.gapEnergyRatioMeasurable, 2)}`, audit.gapRatioMeaningful ? '' : 'warn'],
    ['Gap share of carrier energy', fmt(audit.gapEnergyShareOfCarrier * 100, 2, '%'), ''],
    ['Max gain in unexcited bins', fmt(audit.maxGainInUnexcitedDb, 2, ' dB'), audit.maxGainInUnexcitedDb > 0.01 ? 'bad' : 'ok'],
    ['Unexcited energy ratio', fmt(audit.unexcitedEnergyRatio, 2), audit.unexcitedRatioMeaningful ? '' : 'warn'],
    ['Measurable-bin fraction', fmt(audit.measurableBinFraction * 100, 1, '%'), ''],
  ];

  const findings = [];
  if (tc.outputVsDonor !== null && tc.outputVsDonor < 0.5) {
    findings.push('The output envelope does not follow the donor trend well. Check band range, gap policy and excitation limits; a very sparse carrier (e.g. narrow harmonics) may not support the donor shape.');
  }
  if (a.outputVsCarrier !== null && a.outputVsCarrier < 0.6) {
    findings.push('The output amplitude contour diverges from the carrier. This is expected if loudness matching is off or the carrier is nearly constant; the amplitude envelope is never taken from the donor.');
  }
  if (fitWorseThanIdentity) {
    findings.push('Spectral fit is no better than the identity baseline. The requested donor shape is mostly in bands the carrier cannot excite, so the gain limits and excitation guard are dominating.');
  }
  if (audit.maxGainInUnexcitedDb !== null && audit.maxGainInUnexcitedDb > 0.01) {
    findings.push('A positive gain slipped into unexcited bins — this should not happen in this model; treat the result with suspicion.');
  }
  if (m.coverage.donorGapBinFraction > 0.5) {
    findings.push(`More than half of the shaping region has no donor observation (${fmt(m.coverage.donorGapBinFraction * 100, 0)}%), so most of the output timbre comes from the chosen gap policy (${r.options.freqGapMode}), not from measured donor content.`);
  }
  if (m.coverage.bypassFraction > 0.02) {
    findings.push(`${fmt(m.coverage.bypassFraction * 100, 1)}% of carrier frames fall outside the donor time range and were passed through unchanged (time gap = ${r.options.timeGapMode === 'bypass' ? 'bypass' : 'held'}).`);
  }
  if (findings.length === 0) findings.push('No red flags at the configured thresholds.');

  const modelNotes = [
    'This is cross-synthesis, not source/filter separation: the output is a new sound whose spectral envelope was re-weighted. The donor and carrier are not separated from either input.',
    'The excitation proxy is carrier magnitude divided by the carrier\'s own cepstral spectral envelope. It is not a pitch-synchronous glottal or residual source, and it retains carrier periodicity and noise.',
    'The spectral envelope is a cepstrally smoothed function of frequency. It is distinct from the amplitude envelope, which is a broadband frame-RMS contour and is never transplanted from the donor.',
    'Envelope scale is dB re. a full-scale sinusoid\'s peak bin. Gain is per-bin dB after removing each side\'s own envelope reference, so absolute level is not preserved from the donor.',
    'Observability is a spectral-support test: a band counts as observed only where the donor has partials near it. Unobserved (gap) bands are handled by the chosen frequency policy and clearly not evidence.',
    'Model limits on complex mixes: with several simultaneous sources the cepstral envelope is a mixture envelope, so "donor timbre" is ambiguous; inharmonic or dense polyphony blurs the comb/envelope split; strongly transient content violates the slow-envelope assumption; a carrier with no energy in a band cannot be given timbre there (only attenuation).',
  ];

  const html = `
    <h2>Measurement report</h2>
    <h3>Sources and correspondence</h3>
    <table>${rows.map(([k, v, c]) => `<tr><td>${k}</td><td class="${c}">${v}</td></tr>`).join('')}</table>
    <h3>Energy audit (before loudness / makeup)</h3>
    <table>${auditRows.map(([k, v, c]) => `<tr><td>${k}</td><td class="${c}">${v}</td></tr>`).join('')}</table>
    <p class="hint">${audit.note}</p>
    <h3>Interpretation</h3>
    <ul>${findings.map((f) => `<li>${f}</li>`).join('')}</ul>
    <h3>Model scope and limitations</h3>
    <ul>${modelNotes.map((f) => `<li>${f}</li>`).join('')}</ul>
    <h3>Scales used</h3>
    <table>${Object.entries(m.scaleNotes).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
  `;
  $('report').innerHTML = html;
}

setStatus('ready — press Run');
