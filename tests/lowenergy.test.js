// Regression tests for the low-energy / spectral-trough normalisation fixes.
//
// Each test pins one claim the interface makes after the fix, and fails loudly
// if a future change re-introduces the wrong behaviour:
//
//   1. digital silence is never declared excited (no boost into a zero frame);
//   2. a donor with no valid source spectrum refuses or parks the normaliser
//      write, and reports it to the automation lane;
//   3. the first valid frame after silence starts from its own measurement
//      (low-energy history is reset at the switch), not a smoothed floor;
//   4. a deep carrier spectral trough gets bounded gain, not a global squeeze;
//   5. time bypass really passes the carrier through;
//   6. the numeric envelope / cross gain matches a checked-in golden file.
//
// "有限输出及局部增益" (finite output, bounded local gain) is asserted directly,
// and the golden values are compared to the same code path the UI runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { crossSynthesize, bandReferenceDb } from '../src/dsp/engine.js';
import { smoothEnvelopeTime, estimateSpectralEnvelope, smoothstep } from '../src/dsp/envelope.js';
import { createSTFT } from '../src/dsp/stft.js';
import { resonantTone, generatePulseTrain } from '../src/dsp/sources.js';
import { recordAutomation, applyLaneToFrames } from '../src/dsp/automation.js';
import { runEditorSession, normaliseEdit } from '../src/dsp/editor.js';

const RATE = 22050;
const p2db = (p) => 10 * Math.log10(p + 1e-30);
const rms = (a) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
};
const absPeak = (a) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
};

function donorSweep(dur = 2) {
  return {
    sampleRate: RATE,
    samples: resonantTone({
      rate: RATE, durationSec: dur, f0: 120, amplitude: 0.6,
      formants: [{ freq: 520, bw: 90, gain: 1 }, { freq: 1500, bw: 130, gain: 0.6 },
        { freq: 3000, bw: 220, gain: 0.3 }],
      formantMod: { rateHz: 0.4, depthOct: 0.2 },
    }),
  };
}

// Carrier: silence except a short narrowband tone burst. This is the "static
// small-energy zone + sudden excitation" case from the brief.
function burstCarrier({ rate = RATE, dur = 2, startSec = 0.8, burstSec = 0.05, amp = 0.5 } = {}) {
  const n = Math.round(rate * dur);
  const out = new Float32Array(n);
  const s = Math.round(startSec * rate);
  const L = Math.round(burstSec * rate);
  for (let i = 0; i < L; i++) {
    const env = Math.sin((Math.PI * i) / L) ** 2;
    out[s + i] = amp * env * Math.sin((2 * Math.PI * 1000 * i) / rate);
  }
  return { sampleRate: rate, samples: out };
}

// Donor: silence then a formant tone, so the switch from no-source to valid
// source happens at a known time.
function donorGatedOnset({ rate = RATE, dur = 2, startSec = 1.0 } = {}) {
  const n = Math.round(rate * dur);
  const out = new Float32Array(n);
  const tone = resonantTone({
    rate, durationSec: dur - startSec, f0: 120, amplitude: 0.6,
    formants: [{ freq: 700, bw: 90, gain: 1 }, { freq: 2000, bw: 150, gain: 0.5 }],
  });
  out.set(tone, Math.round(startSec * rate));
  return { sampleRate: rate, samples: out };
}

// ---------------------------------------------------------------------------
test('smoothstep does not produce NaN when its window is degenerate', () => {
  // excitationRangeDb <= 6 makes -range meet the fixed -6 dB edge.
  for (const x of [-80, -6, 0, 3]) {
    const v = smoothstep(-6, -6, x);
    assert.ok(Number.isFinite(v), `smoothstep(-6,-6,${x}) = ${v}`);
  }
});

test('digital-silence carrier frames are never excited and never boosted', () => {
  const donor = donorSweep(1);
  const silent = { sampleRate: RATE, samples: new Float32Array(RATE) };
  const r = crossSynthesize(donor, silent, { fftSize: 1024, hop: 256 });
  assert.equal(r.metrics.energy.guardMuted, true, 'all-zero carrier mutes output');
  for (let t = 0; t < r.carrier.spec.frames; t++) {
    for (let k = 0; k < r.carrier.spec.bins; k++) {
      if (r.carrier.spec.power[t][k] === 0) {
        assert.equal(r.carrierExcitation[t][k], 0, `zero bin excited at frame ${t} bin ${k}`);
      }
    }
  }
  assert.equal(r.spectralAudit.maxGainInUnexcitedDb, 0, 'no gain written into silence');
});

test('a tone burst in an otherwise silent carrier is not globally squeezed', () => {
  const donor = donorSweep(2);
  const r = crossSynthesize(donor, burstCarrier(), { fftSize: 1024, hop: 256 });
  // The burst survives in the final output: the peak is a real fraction of the
  // carrier peak. (The spectral stage removes absolute level by design; the
  // explicit makeup restores it, so compare the final output, not the stage.)
  const carPeak = absPeak(r.carrier.samples);
  const outPeak = absPeak(r.output);
  assert.ok(outPeak > carPeak * 0.5, `burst preserved: output ${outPeak} vs carrier ${carPeak}`);
  // The fix must not be a global loudness cut that hides a local boom: the peak
  // guard did not have to engage, and no large negative makeup was applied.
  assert.ok(r.metrics.energy.makeupDb > -6, `makeup ${r.metrics.energy.makeupDb} dB`);
  assert.ok(Math.abs(r.metrics.energy.peakGuardDb) < 3, `peak guard ${r.metrics.energy.peakGuardDb} dB`);
  // Narrow-band: outside the burst the output is not ringing.
  const outside = rms(r.output.subarray(0, Math.round(0.7 * RATE)));
  assert.ok(outside < 0.01, `no ring before the burst: ${outside}`);
  assert.ok(r.output.every(Number.isFinite), 'output finite');
});

test('donor silence: normaliser write is refused and reported to the lane', () => {
  const silentDonor = { sampleRate: RATE, samples: new Float32Array(RATE) };
  const carrier = { sampleRate: RATE, samples: generatePulseTrain({ rate: RATE, durationSec: 1, f0: 220, amplitude: 0.7 }) };
  const r = crossSynthesize(silentDonor, carrier, { fftSize: 1024, hop: 256, lowEnergyPolicy: 'refuse' });
  const c = r.metrics.coverage;
  assert.equal(c.noSourceFrameFraction, 1, 'every frame has no valid source');
  assert.equal(c.refusedWriteFraction, 1, 'every write refused');
  assert.equal(c.heldWriteFraction, 0, 'nothing held when there is no earlier good frame');
  assert.equal(c.lowEnergyPolicy, 'refuse');
  assert.ok(r.sourceTrace.every((s) => s.policy === 'refused' && !s.donorValid));
  // Refused frames write no gain, so the carrier passes through: output energy
  // is not amplified from a floor-derived shape.
  assert.ok(r.metrics.energy.outputOverCarrierRms < 1.15,
    `refused write must not amplify: ratio ${r.metrics.energy.outputOverCarrierRms}`);
  assert.ok(r.output.every(Number.isFinite));

  // The same writes, replayed through the automation lane, are refused.
  const times = Array.from({ length: 8 }, (_, i) => 0.1 * i);
  const writes = times.map((timeSec, i) => ({ timeSec, gainDb: 6, id: i }));
  const rec = recordAutomation(writes, r.sourceTrace, { policy: 'refuse' });
  assert.equal(rec.accepted, 0, 'no automation write committed during silence');
  assert.equal(rec.refused, writes.length);
  const laneGain = applyLaneToFrames(rec.lane, Float32Array.from(times));
  assert.ok(Math.max(...laneGain) === 0, 'lane carries no gain through the silent region');
});

test('automation write during donor silence is parked, then released on valid source', () => {
  const donor = donorGatedOnset(); // 0-1 s silent, 1-2 s valid
  const carrier = { sampleRate: RATE, samples: generatePulseTrain({ rate: RATE, durationSec: 2, f0: 220, amplitude: 0.7 }) };
  const r = crossSynthesize(donor, carrier, { fftSize: 1024, hop: 256, lowEnergyPolicy: 'refuse' });
  // A write at 0.3 s (silence), and one at 1.3 s (valid).
  const writes = [
    { timeSec: 0.3, gainDb: 6, id: 'silent' },
    { timeSec: 1.3, gainDb: 6, id: 'loud' },
  ];
  const rec = recordAutomation(writes, r.sourceTrace, { policy: 'park' });
  const silentEv = rec.events.find((e) => e.id === 'silent');
  const loudEv = rec.events.find((e) => e.id === 'loud' && e.status === 'committed');
  assert.equal(silentEv.status, 'parked', 'write during silence is parked');
  assert.equal(loudEv.status, 'committed');
  // Released at (or after) the first valid frame, never at its silent origin.
  const released = rec.events.find((e) => e.id === 'silent' && e.status === 'committed');
  assert.ok(released && released.releasedAtSec >= 1.0, `released at ${released?.releasedAtSec}`);
  // The effective lane has no gain point inside 0-1 s.
  assert.ok(rec.lane.every((p) => p.timeSec >= 1.0), 'no committed gain lands inside silence');
});

test('a parked write with no valid source stays open, never silently applied', () => {
  const silentDonor = { sampleRate: RATE, samples: new Float32Array(RATE) };
  const carrier = { sampleRate: RATE, samples: generatePulseTrain({ rate: RATE, durationSec: 0.5, f0: 220, amplitude: 0.7 }) };
  const r = crossSynthesize(silentDonor, carrier, { fftSize: 1024, hop: 256 });
  const rec = recordAutomation([{ timeSec: 0.1, gainDb: 9, id: 'x' }], r.sourceTrace, { policy: 'park' });
  assert.equal(rec.accepted, 0);
  assert.equal(rec.parked, 1);
  assert.equal(rec.parkedOpen.length, 1, 'open write is reported, not dropped silently');
  assert.equal(rec.lane.length, 0, 'no effective lane value from an open write');
});

test('low-energy history is reset at the switch: first valid frame uses its own spectrum', () => {
  const hopSec = 0.0116;
  const frames = [];
  for (let t = 0; t < 8; t++) frames.push(Float32Array.from([t < 4 ? -160 : -10, t < 4 ? -160 : -10]));
  const valid = Uint8Array.from([0, 0, 0, 0, 1, 1, 1, 1]);
  const masked = smoothEnvelopeTime(frames, hopSec, 0.15, valid);
  const plain = smoothEnvelopeTime(frames, hopSec, 0.15);
  // Without the reset the first valid frame is dragged toward the floor.
  assert.ok(plain[4][0] < -60, `unmasked bleeds floor: ${plain[4][0].toFixed(1)} dB`);
  // With the reset it reads its own measurement.
  assert.ok(Math.abs(masked[4][0] - -10) < 1e-3, `reset frame reads ${masked[4][0].toFixed(1)} dB`);
  assert.ok(Math.abs(masked[5][0] - -10) < 1e-3, 'subsequent valid frames stay correct');
});

test('donor silence does not smear its floor into the first valid frame of the output', () => {
  // Gated donor (silent then loud) on a steady carrier. The output amplitude at
  // the switch must rise to the shaped level, not a smoothed floor.
  const donor = donorGatedOnset();
  const carrier = { sampleRate: RATE, samples: generatePulseTrain({ rate: RATE, durationSec: 2, f0: 220, amplitude: 0.7 }) };
  const r = crossSynthesize(donor, carrier, { fftSize: 1024, hop: 256 });
  const at = (a) => rms(r.spectralOutput.subarray(Math.round(a * RATE), Math.round((a + 0.05) * RATE)));
  const before = at(0.95 - 0.05); // just before the switch (silence region)
  const justAfter = at(1.02);
  const settled = at(1.5);
  assert.ok(settled > 0, 'output has energy after the donor turns on');
  assert.ok(justAfter > settled * 0.5,
    `first valid output frame not suppressed by floor: ${justAfter.toExponential(2)} vs ${settled.toExponential(2)}`);
  void before;
  assert.ok(r.output.every(Number.isFinite));
});

test('a deep carrier spectral trough receives bounded local gain, not a global squeeze', () => {
  // Carrier with two very narrow formants and a deep valley; donor broad.
  const carrier = {
    sampleRate: RATE,
    samples: resonantTone({
      rate: RATE, durationSec: 2, f0: 200, amplitude: 0.7, source: 'pulse',
      formants: [{ freq: 300, bw: 25, gain: 1 }, { freq: 3000, bw: 25, gain: 1 }],
    }),
  };
  const donor = {
    sampleRate: RATE,
    samples: resonantTone({
      rate: RATE, durationSec: 2, f0: 120, amplitude: 0.6,
      formants: [{ freq: 600, bw: 200, gain: 1 }, { freq: 1800, bw: 300, gain: 0.7 }],
    }),
  };
  const r = crossSynthesize(donor, carrier, { fftSize: 1024, hop: 256 });
  // Every commanded gain is inside the clamps.
  for (let t = 0; t < r.carrier.spec.frames; t++) {
    for (let k = 0; k < r.carrier.spec.bins; k++) {
      const g = r.gainsDb[t][k];
      assert.ok(Number.isFinite(g));
      assert.ok(g <= r.options.maxBoostDb + 1e-6, `boost clamp: ${g}`);
      assert.ok(g >= -r.options.maxCutDb - 1e-6, `cut clamp: ${g}`);
    }
  }
  // In frames with real carrier content, the applied local gain never exceeds
  // the commanded clamp by more than a small overlap-add tolerance, so the
  // trough is shaped, not blown up.
  let worstOvershoot = -Infinity;
  for (let t = 0; t < r.carrier.spec.frames; t++) {
    const p = r.carrier.spec.power[t];
    let peak = 0;
    for (let k = 1; k < r.carrier.spec.bins; k++) peak = Math.max(peak, p[k]);
    if (p2db(peak) < -60) continue;
    for (let k = 1; k < r.carrier.spec.bins; k++) {
      const rel = p2db(p[k]) - p2db(peak);
      if (rel < -40) continue;
      const applied = p2db(r.outSpec.power[t][k]) - p2db(p[k]);
      worstOvershoot = Math.max(worstOvershoot, applied - r.gainsDb[t][k]);
    }
  }
  // Overlap-add between frames adds leakage; allow a modest tolerance, but not
  // the tens of dB a runaway normaliser would produce.
  assert.ok(worstOvershoot < 20, `local gain overshoot ${worstOvershoot.toFixed(1)} dB`);
  assert.ok(r.output.every(Number.isFinite));
});

test('time bypass passes the carrier through; it is not a silent hole', () => {
  const donor = donorSweep(2);
  const carrier = { sampleRate: RATE, samples: generatePulseTrain({ rate: RATE, durationSec: 4, f0: 220, amplitude: 0.7 }) };
  const r = crossSynthesize(donor, carrier, { fftSize: 1024, hop: 256, timeMap: 'start', timeGapMode: 'bypass' });
  assert.ok(r.metrics.coverage.bypassFraction > 0.4, 'tail is bypassed');
  const half = Math.floor(r.carrier.samples.length / 2);
  const carTail = rms(r.carrier.samples.subarray(half));
  const outTail = rms(r.spectralOutput.subarray(half));
  assert.ok(outTail > carTail * 0.8,
    `bypassed tail should pass through: ${outTail.toFixed(3)} vs carrier ${carTail.toFixed(3)}`);
});

test('silence gap followed by a narrowband burst: no amplified wrong envelope is left behind', () => {
  // Donor is silent for the first second; carrier is silent then a burst.
  // Rendering once (the "reopen") must not have baked a boosted envelope.
  const donor = donorGatedOnset();
  const r = crossSynthesize(donor, burstCarrier(), { fftSize: 1024, hop: 256 });
  // In the carrier's silent region, no gain is written.
  for (let t = 0; t < r.carrier.spec.frames; t++) {
    const tSec = r.sourceTrace[t].timeSec;
    if (tSec > 0.6 && tSec < 0.75) {
      for (let k = 0; k < r.carrier.spec.bins; k++) {
        assert.ok(r.gainsDb[t][k] <= 0, `no boost before burst at ${tSec.toFixed(2)}s: ${r.gainsDb[t][k]}`);
      }
    }
  }
  // Re-running on the same inputs is deterministic and still finite: the error
  // envelope is not persisted into shared state.
  const r2 = crossSynthesize(donor, burstCarrier(), { fftSize: 1024, hop: 256 });
  assert.equal(r.metrics.gainRangeDb.max, r2.metrics.gainRangeDb.max, 'deterministic rerun');
  assert.ok(r2.output.every(Number.isFinite));
});

// ---------------------------------------------------------------------------
// Numeric regression against the checked-in golden file. These values are the
// "execution evidence" for the finite-output / local-gain claims: they are the
// same code path the UI runs, pinned so a silent regression cannot pass.
test('numeric envelope + cross-gain regression matches the golden file', () => {
  const goldenPath = fileURLToPath(new URL('./golden/envelope.json', import.meta.url));
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  const g = golden.envelope;

  const src = resonantTone({
    rate: g.rate, durationSec: 1, f0: 120, amplitude: 0.6,
    formants: [{ freq: 600, bw: 90, gain: 1 }, { freq: 1800, bw: 160, gain: 0.5 }],
  });
  const stft = createSTFT({ fftSize: g.fftSize, hop: g.hop, sampleRate: g.rate });
  const spec = stft.analyze(src);
  const env = estimateSpectralEnvelope(spec, {
    bandsPerOctave: g.bandsPerOctave, fMin: g.fMin, fMax: g.fMax,
    lifterSamples: Math.round(0.003 * g.rate),
  });
  const t = g.frame;
  const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
  const nb = env.centres.length;
  const bandIdx = [0, Math.round(nb * 0.25), Math.round(nb * 0.5), Math.round(nb * 0.75), nb - 1];
  bandIdx.forEach((b, i) => {
    assert.ok(Math.abs(round(env.db[t][b], 3) - g.smoothedDb[i]) <= 0.05,
      `smoothed band ${b} (${g.centresHz[i]} Hz): ${env.db[t][b]} vs golden ${g.smoothedDb[i]}`);
    assert.ok(Math.abs(round(env.rawBandDb[t][b], 3) - g.rawDb[i]) <= 0.05,
      `raw band ${b}: ${env.rawBandDb[t][b]} vs golden ${g.rawDb[i]}`);
  });

  // Cross-synthesis golden.
  const donor = {
    sampleRate: RATE,
    samples: resonantTone({
      rate: RATE, durationSec: 1.5, f0: 120, amplitude: 0.6,
      formants: [{ freq: 520, bw: 90, gain: 1 }, { freq: 1500, bw: 130, gain: 0.6 }, { freq: 3000, bw: 220, gain: 0.3 }],
      formantMod: { rateHz: 0.4, depthOct: 0.2 },
    }),
  };
  const carrier = { sampleRate: RATE, samples: generatePulseTrain({ rate: RATE, durationSec: 1.5, f0: 220, pulseWidthMs: 2, amplitude: 0.7 }) };
  const r = crossSynthesize(donor, carrier, { fftSize: 1024, hop: 256 });
  const cg = golden.cross;
  const near = (actual, expected, tol, msg) =>
    assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected} +/- ${tol}`);
  near(round(r.metrics.trendCorr.outputVsDonor, 4), cg.trendOutputVsDonor, 0.01, 'trend output/donor');
  near(round(r.metrics.trendCorr.outputVsCarrier, 4), cg.trendOutputVsCarrier, 0.01, 'trend output/carrier');
  near(round(r.metrics.spectralFit.meanAbsDb, 4), cg.spectralFitMeanAbsDb, 0.05, 'spectral fit');
  near(round(r.metrics.energy.outputOverCarrierRms, 4), cg.outputOverCarrierRms, 0.002, 'output/carrier RMS');
  near(round(r.metrics.gainRangeDb.max, 4), cg.gainMax, 0.02, 'gain max');
  near(round(r.metrics.gainRangeDb.min, 4), cg.gainMin, 0.02, 'gain min');
  assert.equal(r.spectralAudit.maxGainInUnexcitedDb, cg.maxGainInUnexcitedDb, 'unexcited max gain');
  assert.ok(r.output.every(Number.isFinite), 'finite output');
});

// ---------------------------------------------------------------------------
// Spectral-editor session: the two-source picker and the overlay must be driven
// by the real cross-synthesis kernel, and the feedback string must reflect its
// actual result. This exercises the compute path app.js calls, without a DOM.
test('spectral editor: two chosen sources render through the cross-synthesis kernel', () => {
  const session = runEditorSession({ donorPreset: 'sweepingVowel', carrierPreset: 'pulse220', band: 20, db: 0 });
  assert.ok(session.finite, 'editor output finite');
  assert.equal(session.edit, null, '0 dB is no edit');
  // The cross spectrum (spectral-stage output) and the shaped sound both exist
  // and both come from the kernel.
  assert.ok(session.result.spectralOutput.length > 0, 'cross spectrum audio present');
  assert.ok(session.result.output.length > 0, 'shaped audio present');
  // Feedback is built from the kernel's own numbers.
  assert.match(session.status, /gain .*dB/);
  assert.match(session.status, /refused writes/);
  assert.match(session.status, /output\/carrier RMS/);
});

test('spectral editor: the overlay changes the kernel gain map, not just the label', () => {
  const base = runEditorSession({ donorPreset: 'staticNasal', carrierPreset: 'pulse220', band: 20, db: 0 });
  const up = runEditorSession({ donorPreset: 'staticNasal', carrierPreset: 'pulse220', band: 20, db: 12 });
  assert.ok(up.edit && up.edit.length === 1, 'edit parsed');
  // A +12 dB band offset must move the target shape at that band by ~12 dB.
  const nb = base.result.donorEnv.centres.length;
  const b = 20;
  const t = Math.floor(base.result.carrier.spec.frames / 2);
  const baseShape = base.result.targetShapeBand[t][b];
  const upShape = up.result.targetShapeBand[t][b];
  assert.ok(Math.abs((upShape - baseShape) - 12) < 1.5,
    `overlay moved target shape by ${(upShape - baseShape).toFixed(2)} dB, expected ~12`);
  assert.ok(up.result.metrics.gainRangeDb.max >= base.result.metrics.gainRangeDb.max,
    'overlay raises the gain where it boosts');
  assert.ok(up.finite, 'edited output finite');
  void nb;
});

test('spectral editor: normaliseEdit rejects non-finite and zero edits', () => {
  assert.equal(normaliseEdit(NaN, 5), null);
  assert.equal(normaliseEdit(3, NaN), null);
  assert.equal(normaliseEdit(3, 0), null);
  assert.deepEqual(normaliseEdit(3, 6), [{ band: 3, db: 6 }]);
});

test('lowEnergyPolicy hold: donor that falls silent mid-stream holds the last good frame', () => {
  // Donor: 1 s tone, then 1 s silence. With 'hold', the silent tail should
  // reuse the last valid donor frame and not count as refused; the output stays
  // finite and gains stay clamped.
  const n = 2 * RATE;
  const donorSamples = new Float32Array(n);
  donorSamples.set(resonantTone({
    rate: RATE, durationSec: 1, f0: 120, amplitude: 0.6,
    formants: [{ freq: 700, bw: 90, gain: 1 }],
  }), 0);
  const donor = { sampleRate: RATE, samples: donorSamples };
  const carrier = { sampleRate: RATE, samples: generatePulseTrain({ rate: RATE, durationSec: 2, f0: 220, amplitude: 0.7 }) };
  const hold = crossSynthesize(donor, carrier, { fftSize: 1024, hop: 256, lowEnergyPolicy: 'hold' });
  const refuse = crossSynthesize(donor, carrier, { fftSize: 1024, hop: 256, lowEnergyPolicy: 'refuse' });
  const hc = hold.metrics.coverage;
  const rc = refuse.metrics.coverage;
  assert.ok(hc.noSourceFrameFraction > 0.3, `hold: no-source fraction ${hc.noSourceFrameFraction}`);
  assert.ok(hc.heldWriteFraction > 0.3, `hold: held fraction ${hc.heldWriteFraction}`);
  assert.equal(hc.refusedWriteFraction, 0, 'hold: nothing refused while a good frame exists');
  assert.ok(rc.refusedWriteFraction > 0.3, `refuse: refused fraction ${rc.refusedWriteFraction}`);
  assert.equal(rc.heldWriteFraction, 0, 'refuse: nothing held');
  assert.ok(hold.output.every(Number.isFinite) && refuse.output.every(Number.isFinite));
  for (const r of [hold, refuse]) {
    assert.ok(r.metrics.gainRangeDb.max <= r.options.maxBoostDb + 1e-6, 'boost clamp holds');
  }
});
