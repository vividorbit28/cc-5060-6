// Deterministic synthetic sources used both by the interface and the tests.
// The point of these generators is to give each signal a *known* origin for
// one property and no claim about the other:
//   - a pulse-excited resonator has a slow formant envelope (spectral) and a
//     period set by the pulse rate (excitation);
//   - a bare pulse train has only the excitation period;
//   - noise has a broad, nearly flat excitation and no period.
// Tests can therefore check which property survived the transplant.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One-pole lowpass, used only to give the noise a gentle tilt.
function pinkFilter(x, rng) {
  const out = new Float32Array(x.length);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < x.length; i++) {
    const w = x[i];
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
  }
  return out;
}

export function generateNoise({ rate, durationSec, color = 'white', seed = 1, amplitude = 0.5 }) {
  const n = Math.max(1, Math.round(rate * durationSec));
  const rng = mulberry32(seed);
  const out = new Float32Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = rng() * 2 - 1;
    out[i] = v;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n) || 1;
  const g = amplitude / rms;
  for (let i = 0; i < n; i++) out[i] *= g;
  const shaped = color === 'pink' ? pinkFilter(out, rng) : out;
  if (color === 'pink') {
    let s = 0;
    for (let i = 0; i < n; i++) s += shaped[i] * shaped[i];
    const r = Math.sqrt(s / n) || 1;
    const k = amplitude / r;
    for (let i = 0; i < n; i++) shaped[i] *= k;
  }
  return shaped;
}

// Raised-cosine pulse, centred at `start` (float sample index).
function addPulse(out, start, widthSamples, amp) {
  const half = Math.max(1, widthSamples / 2);
  const i0 = Math.floor(start - half);
  const i1 = Math.ceil(start + half);
  for (let i = i0; i <= i1; i++) {
    if (i < 0 || i >= out.length) continue;
    const x = (i - start) / half;
    if (Math.abs(x) >= 1) continue;
    const w = 0.5 + 0.5 * Math.cos(Math.PI * x);
    out[i] += amp * w;
  }
}

export function generatePulseTrain({
  rate,
  durationSec,
  f0 = 100,
  pulseWidthMs = 2,
  seed = 1,
  amplitude = 0.8,
  periodJitterPct = 0,
  ampJitterPct = 0,
}) {
  if (!(f0 > 0)) throw new Error('f0 must be positive');
  const n = Math.max(1, Math.round(rate * durationSec));
  const out = new Float32Array(n);
  const rng = mulberry32(seed);
  const period = rate / f0;
  const width = Math.max(1, (pulseWidthMs / 1000) * rate);
  let t = 0;
  while (t < n) {
    const jitter = periodJitterPct ? (rng() * 2 - 1) * (periodJitterPct / 100) * period : 0;
    const amp = amplitude * (1 + (ampJitterPct ? (rng() * 2 - 1) * (ampJitterPct / 100) : 0));
    addPulse(out, t + jitter, width, amp);
    t += period;
  }
  return out;
}

function resonatorCoeffs(freq, bw, rate) {
  const theta = (2 * Math.PI * Math.min(freq, rate * 0.49)) / rate;
  const r = Math.exp((-Math.PI * bw) / rate);
  const a1 = 2 * r * Math.cos(theta);
  const a2 = -r * r;
  // gain at resonance normalised so the mode is roughly unity for a unit pulse
  const g = (1 - r) * Math.sqrt(1 + r * r - 2 * r * Math.cos(2 * theta));
  return { a1, a2, g };
}

// A parallel bank of two-pole resonators fed by a pulse train or noise.
// `formantMod` slowly moves the formants, which gives the donor a genuine slow
// spectral-envelope trend rather than a static filter.
export function generateResonantTone({
  rate,
  durationSec,
  f0 = 110,
  formants = [{ freq: 700, bw: 90, gain: 1 }, { freq: 1200, bw: 120, gain: 0.7 }, { freq: 2600, bw: 160, gain: 0.4 }],
  source = 'pulse',
  pulseWidthMs = 2,
  noiseColor = 'pink',
  seed = 1,
  amplitude = 0.7,
  tremoloHz = 0,
  tremoloDepth = 0,
  formantMod = { rateHz: 0, depthOct: 0 },
}) {
  const n = Math.max(1, Math.round(rate * durationSec));
  let excitation;
  if (source === 'noise') {
    excitation = generateNoise({ rate, durationSec, color: noiseColor, seed, amplitude: 1 });
  } else {
    excitation = generatePulseTrain({ rate, durationSec, f0, pulseWidthMs, seed, amplitude: 1 });
  }
  const out = new Float32Array(n);
  const blockSize = 64;
  const coefficients = formants.map(() => ({ a1: 0, a2: 0, g: 0 }));
  const state = formants.map(() => ({ y1: 0, y2: 0 }));
  for (let start = 0; start < n; start += blockSize) {
    const end = Math.min(n, start + blockSize);
    const tSec = start / rate;
    const mod = formantMod.depthOct
      ? Math.pow(2, formantMod.depthOct * Math.sin(2 * Math.PI * formantMod.rateHz * tSec))
      : 1;
    for (let f = 0; f < formants.length; f++) {
      const c = resonatorCoeffs(formants[f].freq * mod, formants[f].bw, rate);
      coefficients[f] = c;
    }
    for (let i = start; i < end; i++) {
      const x = excitation[i];
      let sum = 0;
      for (let f = 0; f < formants.length; f++) {
        const st = state[f];
        const c = coefficients[f];
        const y = c.g * x + c.a1 * st.y1 + c.a2 * st.y2;
        st.y2 = st.y1;
        st.y1 = y;
        sum += y * formants[f].gain;
      }
      out[i] = sum;
    }
  }
  // Normalise, then apply a slow *amplitude* envelope. That tremolo is
  // deliberately orthogonal to the spectral envelope: the cross-synthesis
  // pipeline must not transplant it, and the interface plots both separately.
  let maxAbs = 0;
  for (let i = 0; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(out[i]));
  if (maxAbs > 1e-12) {
    const k = amplitude / maxAbs;
    for (let i = 0; i < n; i++) out[i] *= k;
  }
  if (tremoloHz > 0 && tremoloDepth > 0) {
    for (let i = 0; i < n; i++) {
      const m = 1 - tremoloDepth * (0.5 - 0.5 * Math.cos(2 * Math.PI * tremoloHz * (i / rate)));
      out[i] *= m;
    }
  }
  return out;
}

// Wrap the generator so callers always get fresh state (it is pure now, kept as
// a distinct name so tests read like the prose).
export function resonantTone(args) {
  return generateResonantTone(args);
}

export function fadeInOut(x, rate, fadeMs = 5) {
  const f = Math.max(1, Math.round((fadeMs / 1000) * rate));
  const n = x.length;
  const k = Math.min(f, Math.floor(n / 2));
  for (let i = 0; i < k; i++) {
    const g = i / k;
    x[i] *= g;
    x[n - 1 - i] *= g;
  }
  return x;
}

export function silence(rate, durationSec) {
  return new Float32Array(Math.max(1, Math.round(rate * durationSec)));
}
