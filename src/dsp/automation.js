// Host automation lane for the norm-control gain.
//
// The shaper's spectral stage produces a per-frame gain. A host (DAW, spectral
// editor) can "ride" that gain as an automation lane: the user turns the
// norm-control up, the host writes a gain value, and on the next render the
// engine re-normalises. The dangerous case is a write made while the donor has
// no valid source spectrum (a silent passage, or a deep spectral trough): the
// normaliser would divide by, or normalise against, a numerical floor and bake
// an amplified wrong envelope into the automation lane. That lane then reopens
// with the wrong value and the error is not recoverable from the audio alone.
//
// This module makes the decision explicit and inspectable:
//
//   * a write is COMMITTED only when the donor has a valid source spectrum for
//     the frame it lands on;
//   * a write during silence is PARKED (queued, with its original gain) rather
//     than applied -- it is re-offered when the donor becomes valid again;
//   * if there is no earlier valid frame to defer to and the caller asks for a
//     hard rule, the write is REFUSED (dropped, reported back to the lane).
//
// Everything is pure and synchronous so a test can replay a lane without a DAW.
// The lane result carries the accepted/ parked/ refused counts so the UI can
// show the feedback instead of silently swallowing a bad write.

export const WRITE_COMMITTED = 'committed';
export const WRITE_PARKED = 'parked';
export const WRITE_REFUSED = 'refused';
export const WRITE_PASSED = 'passed';

// A "source sample" is the evidence at one automation time: whether the donor
// had a valid spectrum there and, if so, the envelope reference / gain it
// implies. `sourceTrace` from crossSynthesize is already in this shape.
export function sourceAt(trace, timeSec) {
  if (!trace || !trace.length) return { valid: false, policy: 'none', frame: -1 };
  // Nearest frame in time; the trace is sorted by timeSec.
  let lo = 0;
  let hi = trace.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trace[mid].timeSec < timeSec) lo = mid + 1;
    else hi = mid;
  }
  let best = lo;
  if (lo > 0 && Math.abs(trace[lo - 1].timeSec - timeSec) <= Math.abs(trace[lo].timeSec - timeSec)) {
    best = lo - 1;
  }
  const s = trace[best];
  return { valid: !!s.donorValid, policy: s.policy, frame: s.donorFrame, timeSec: s.timeSec };
}

// Commit / park / refuse a sequence of gain writes against a source trace.
//
// writes: [{ timeSec, gainDb, id? }]
// opts:
//   policy: 'park' (default) keeps an invalid write queued with its value and
//           re-offers it once a valid frame is reached; 'refuse' drops it.
//   toleranceSec: a parked write is re-offered at the first valid frame at or
//           after its time within this window (default = one frame hop).
//
// Returns { events, lane, accepted, parked, refused, parkedOpen }.
// `lane` is the effective gain per write time after the rule is applied; a
// parked write shows the value it will take if and when it is released.
export function recordAutomation(writes, trace, opts = {}) {
  const policy = opts.policy ?? 'refuse';
  const events = [];
  const pending = [];
  let accepted = 0;
  let parked = 0;
  let refused = 0;

  const sorted = [...writes].sort((a, b) => a.timeSec - b.timeSec);
  for (const w of sorted) {
    if (!Number.isFinite(w.gainDb)) {
      refused++;
      events.push({ ...w, status: WRITE_REFUSED, reason: 'non-finite gain' });
      continue;
    }
    const src = sourceAt(trace, w.timeSec);
    if (src.valid) {
      accepted++;
      events.push({ ...w, status: WRITE_COMMITTED, sourceFrame: src.frame });
      // Any parked writes whose time is now covered by valid evidence are
      // released at this point, in order, keeping the value the user wrote.
      while (pending.length) {
        const p = pending.shift();
        events.push({
          ...p.write,
          status: WRITE_COMMITTED,
          releasedAtSec: w.timeSec,
          sourceFrame: src.frame,
          reason: 'deferred until a valid source spectrum',
        });
        parked--; accepted++;
      }
      continue;
    }
    // Invalid source here.
    if (policy === 'park') {
      parked++;
      pending.push({ write: w });
      events.push({ ...w, status: WRITE_PARKED, reason: 'no valid source spectrum' });
    } else {
      refused++;
      events.push({ ...w, status: WRITE_REFUSED, reason: 'no valid source spectrum' });
    }
  }

  // A parked write that never finds a valid frame is reported as still open,
  // not silently applied. This is the "cannot write, tell the lane" branch.
  const parkedOpen = pending.map((p) => p.write);

  // Effective lane value at each distinct write time. Parked-and-released
  // writes take effect at their release time, not their original time, so the
  // lane never shows an amplified value inside the silent gap.
  const lane = [];
  for (const ev of events) {
    if (ev.status !== WRITE_COMMITTED) continue;
    lane.push({ timeSec: ev.releasedAtSec ?? ev.timeSec, gainDb: ev.gainDb, id: ev.id ?? null });
  }

  return { events, lane, accepted, parked, refused, parkedOpen };
}

// Convenience for the host: dot the recorded lane onto a per-frame gain array
// (dB) at the automation times, holding the last value between points. Returns
// a Float32Array of the same length as `times`.
export function applyLaneToFrames(lane, times) {
  const out = new Float32Array(times.length);
  if (!lane.length) return out;
  let j = 0;
  let current = 0;
  for (let i = 0; i < times.length; i++) {
    while (j < lane.length && lane[j].timeSec <= times[i]) {
      current = lane[j].gainDb;
      j++;
    }
    out[i] = current;
  }
  return out;
}
