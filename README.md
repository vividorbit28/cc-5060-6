# Cross-source spectral shaper

A dual-input cross-synthesiser. A slowly varying **spectral envelope** is estimated
from one sound (the *donor*) and used to re-weight the **excitation structure** of
another (the *carrier*). The result is a new, audible timbre: the carrier's
periodicity, noise and amplitude contour, wearing the donor's broad spectral shape.

This is **not** source/filter separation. Neither input is unmixed; two waveforms
are never multiplied in the time domain. The output is an analysis–resynthesis
product, and the report says so explicitly.

## Run it

```sh
npm install          # only playwright-core, used by the UI smoke test
npm test             # 21 DSP tests, node --test
npm start            # static server on http://127.0.0.1:8080/
npm run test:ui      # headless Chromium smoke test of the page
```

Open the printed URL, press **Run**. The page offers built-in synthetic sources
(resonant tones, pulse trains, white/pink noise) or your own files. Every stage can
be soloed: donor, carrier, the excitation proxy, the spectral stage before level
normalisation, and the final output.

## What it does

1. **Resample** both inputs to a common work rate (the max input rate, capped at
   48 kHz, or a rate you choose). The Kaiser-windowed sinc resampler is RMS-preserving,
   and the achieved RMS ratio is reported so energy cannot grow silently. A DC test
   confirms no gain drift.
2. **STFT** the carrier (Hann, coherent-gain normalised so a full-scale sinusoid reads
   0 dB at its peak bin).
3. **Estimate the donor's spectral envelope** by cepstral smoothing: log-magnitude →
   real cepstrum → keep low quefrencies below the donor's measured fundamental
   period → back. This removes the harmonic comb and keeps the formants, so the
   envelope is genuinely *spectral* and smooth, not a per-bin copy of the spectrum.
4. **Estimate the carrier's envelope** the same way (from its own period).
5. **Shape transfer.** For each bin, the gain is
   `(donor band shape) − (carrier band shape)`, where each "shape" is dB after
   subtracting that source's own energy-mean envelope reference. Absolute level is
   therefore *not* transplanted; only the shape moves.
6. **Excitation guard.** Bins whose carrier energy is below `excitationRangeDb` under
   the frame peak — near the numerical floor — may only be attenuated, never boosted.
   No division by a near-zero envelope is used anywhere.
7. **Resynthesise** with weighted overlap-add, then explicitly **normalise** level:
   optional carrier-loudness-contour matching, an explicit makeup gain
   (match carrier RMS / unity / user dB), and a peak ceiling.
8. **Re-analyse** the output with its *own* measured period for the lifter, and report
   trend correlation, excitation period, amplitude correlation, spectral fit vs an
   identity baseline, and an energy audit measured *before* loudness and makeup.

## Explicit scales and representations

| Quantity | Representation |
| --- | --- |
| Spectral envelope | dB re. a full-scale sinusoid's peak bin (0 dB), evaluated per FFT bin |
| Frequency grid | FFT bins; a log-spaced band grid (uniform in log2 Hz, `bandsPerOctave`) for gap handling and display |
| Amplitude envelope | dBFS broadband frame RMS — a **different object**, never transplanted |
| Gain | per-bin dB, both envelope references removed, clamped to `maxBoostDb` / `maxCutDb` |
| Excitation proxy | carrier magnitude ÷ its own cepstral envelope; bounded and support-weighted |

The UI draws the donor, carrier and output envelopes on a shared dB scale and a shared
log-frequency axis, next to the gain map, the mask map (carrier excitation, unexcited
regions, donor-unobserved bands, gap-filled bands) and the amplitude contours.

## Gaps and low energy

- **Time correspondence** is chosen by the user: stretch the donor across the carrier
  (covers all frames), or start-align with an optional offset. Frames outside the donor
  are either *held* (last donor frame) or *bypassed* (the carrier passes unchanged).
  Coverage is reported as covered / held / bypassed fractions.
- **Frequency gaps** — donor bands with no spectral support (e.g. a band-limited donor's
  empty top octave) — have three policies:
  - `extrapolate`: bounded linear continuation (rise ≤ `extrapolateMaxRiseDb`,
    fall ≤ `extrapolateMaxFallDb`),
  - `hold`: nearest observed band,
  - `bypass`: no shaping there.
  Observability is a **spectral-support test** (band peak vs the frame's noise floor),
  not a loudness test, so a quiet but present partial is not mistaken for a gap.
- **Very low energy** never causes division-driven amplification: gains are computed in
  the shape domain, the excitation guard forbids boosting unexcited bins, and the
  reported audit shows the maximum gain actually applied in unexcited bins (0 in the
  tests).

## Verification in the test suite

`npm test` asserts, among others:

- FFT correctness; STFT reconstruction SNR > 40 dB.
- Envelope scale is absolute: −20 dB and −40 dB inputs read −20 / −40 dB.
- A harmonic source's envelope is smoother than its raw band peaks (comb removed).
- Resampling preserves RMS (down and up) with no invented energy; DC level holds.
- The output envelope follows the **donor** trend (correlation ≈ 0.99) and beats the
  carrier trend.
- The output **excitation period** comes from the **carrier**, not the donor.
- The output **amplitude contour** follows the carrier, not a donor tremolo.
- Broadband noise is not reported as periodic.
- Unexcited bins never receive positive gain.
- Total energy is bounded and the achieved energy ratio matches the gains' prediction.
- Output loudness equals the carrier's under explicit normalisation.
- Frequency- and time-gap policies stay distinguishable; different input rates are
  converted with RMS preserved; a silent or extremely quiet carrier produces no
  runaway amplification.

`npm run test:ui` drives the real page in headless Chromium: it runs the analysis,
checks the report text (including the "not separation" statement and the limitations),
verifies every canvas is painted, exercises all five solo buttons, and re-runs under a
different gap policy.

## Where the model breaks on complex mixes

- With several simultaneous sources the cepstral envelope is a **mixture** envelope;
  "the donor's timbre" is then ambiguous, and the shaped result inherits that ambiguity.
- Inharmonic or dense polyphony blurs the comb/envelope split: a cepstral lifter can no
  longer cleanly separate excitation from formant, so some comb may survive or some
  formant detail may be lost.
- The model assumes a **slowly varying** envelope. Strong transients and fast formant
  motion violate it; increase `envSmoothSec` knowingly, not silently.
- A carrier with no energy in a band cannot be *given* timbre there — only attenuated.
  The gap policies invent shape where there is no donor evidence, and the report flags
  when most of the shaping region is extrapolated rather than measured.
- This is envelope transfer on the carrier's own excitation; it is not pitch, formant or
  source separation, and it does not recover the donor's excitation or the carrier's
  original filter.

## Layout

```
src/dsp/fft.js        radix-2 FFT
src/dsp/resample.js   Kaiser sinc resampler, windows, rms/peak
src/dsp/stft.js       STFT analysis / weighted overlap-add synthesis
src/dsp/envelope.js   log bands, cepstral spectral envelope, observability
src/dsp/sources.js    deterministic synthetic donors / carriers
src/dsp/engine.js     cross-synthesis pipeline, gaps, audit, metrics, images
src/ui/               index.html, style.css, app.js (Web Audio playback + canvases)
tests/dsp.test.js     DSP test suite
tools/serve.mjs       dependency-free static server
tools/ui-smoke.mjs    headless Chromium smoke test
```
