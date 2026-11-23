// Radix-2 complex FFT with a reusable plan. Forward uses exp(-i*2*pi*jk/N).

function makeRev(n, levels) {
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let j = 0; j < levels; j++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    rev[i] = r;
  }
  return rev;
}

export function createFFT(n) {
  if (n < 2 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT size must be a power of two >= 2 (got ${n})`);
  }
  const levels = Math.round(Math.log2(n));
  const rev = makeRev(n, levels);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }

  function transform(re, im, sign) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step];
          const wi = sign * sin[j * step];
          const a = start + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  return {
    size: n,
    forward(re, im) {
      transform(re, im, -1);
    },
    inverse(re, im) {
      transform(re, im, 1);
      const inv = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= inv;
        im[i] *= inv;
      }
    },
  };
}

const planCache = new Map();

export function getFFT(n) {
  let plan = planCache.get(n);
  if (!plan) {
    plan = createFFT(n);
    planCache.set(n, plan);
  }
  return plan;
}

// Convenience: real signal -> full complex spectrum (length n).
export function rfft(x, n) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x.subarray ? x.subarray(0, Math.min(n, x.length)) : x.slice(0, Math.min(n, x.length)));
  getFFT(n).forward(re, im);
  return { re, im };
}

export function irfft(re, im) {
  const n = re.length;
  const r = Float64Array.from(re);
  const i = Float64Array.from(im);
  getFFT(n).inverse(r, i);
  return r;
}
