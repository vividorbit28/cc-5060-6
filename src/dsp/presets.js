// Built-in synthetic sources shared by the UI and the headless tests. Kept in
// the DSP tree (not the UI) so the spectral-editor session can be exercised
// without a DOM, using exactly the sources the page offers.

import { resonantTone, generatePulseTrain, generateNoise } from '../dsp/sources.js';

export const PRESET_RATE = 44100;

export function donorSamples(preset, seconds, rate = PRESET_RATE) {
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
    case 'brightBandLimited':
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

export function carrierSamples(preset, seconds, f0, rate = PRESET_RATE) {
  switch (preset) {
    case 'pulse220': return generatePulseTrain({ rate, durationSec: seconds, f0: f0 || 220, pulseWidthMs: 2, amplitude: 0.7 });
    case 'pulse90': return generatePulseTrain({ rate, durationSec: seconds, f0: f0 || 90, pulseWidthMs: 2.5, amplitude: 0.7 });
    case 'pulse330': return generatePulseTrain({ rate, durationSec: seconds, f0: f0 || 330, pulseWidthMs: 1.6, amplitude: 0.7 });
    case 'whiteNoise': return generateNoise({ rate, durationSec: seconds, color: 'white', seed: 3, amplitude: 0.45 });
    case 'pinkNoise': return generateNoise({ rate, durationSec: seconds, color: 'pink', seed: 4, amplitude: 0.5 });
    default: throw new Error(`unknown carrier preset ${preset}`);
  }
}
