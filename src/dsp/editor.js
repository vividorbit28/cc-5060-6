// Spectral-editor session logic, independent of the DOM.
//
// The editor window lets the user pick two sources and an envelope-edit overlay
// and shows / plays the cross spectrum and the shaped sound. All of that has to
// come from the real cross-synthesis kernel, not a stand-in. This module owns
// that mapping so the same code path is testable headlessly and is what app.js
// calls. `runEditorSession` returns the kernel result plus a short, factual
// status string built from that result -- if the render refuses writes or the
// gain range clamps, the status says so rather than hiding it.

import { crossSynthesize } from './engine.js';
import { donorSamples, carrierSamples, PRESET_RATE } from './presets.js';

export const EDITOR_OPTIONS = Object.freeze({
  fftSize: 2048,
  hop: 512,
  lowEnergyPolicy: 'refuse',
});

export function buildEditorSources({ donorPreset, carrierPreset, seconds = 2.5, rate = PRESET_RATE }) {
  const donor = { sampleRate: rate, samples: donorSamples(donorPreset, seconds, rate) };
  const carrier = { sampleRate: rate, samples: carrierSamples(carrierPreset, seconds, 220, rate) };
  return { donor, carrier };
}

export function normaliseEdit(bandRaw, dbRaw) {
  const band = Number(bandRaw);
  const db = Number(dbRaw);
  if (!Number.isFinite(band) || !Number.isFinite(db)) return null;
  if (db === 0) return null;
  return [{ band, db }];
}

export function runEditorSession({ donorPreset, carrierPreset, band, db, seconds = 2.5 }) {
  const { donor, carrier } = buildEditorSources({ donorPreset, carrierPreset, seconds });
  const edit = normaliseEdit(band, db);
  const result = crossSynthesize(donor, carrier, { ...EDITOR_OPTIONS, envelopeEdit: edit });
  const g = result.metrics.gainRangeDb;
  const c = result.metrics.coverage;
  const ratio = result.metrics.energy.outputOverCarrierRms;
  const status = [
    `edit ${edit ? `band ${Math.round(edit[0].band)} ${edit[0].db > 0 ? '+' : ''}${edit[0].db} dB` : 'none'}`,
    `work rate ${result.workRate} Hz`,
    `gain ${g.min == null ? '—' : g.min.toFixed(1)}…${g.max == null ? '—' : g.max.toFixed(1)} dB`,
    `refused writes ${(c.refusedWriteFraction * 100).toFixed(1)}%`,
    `held writes ${(c.heldWriteFraction * 100).toFixed(1)}%`,
    `output/carrier RMS ${ratio == null ? '—' : ratio.toFixed(3)}`,
  ].join(' · ');
  return { result, edit, status, finite: result.output.every(Number.isFinite) };
}
