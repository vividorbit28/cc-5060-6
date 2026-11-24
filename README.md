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
npm test             # 37 DSP + regression tests, node --test
npm start            # static server on http://127.0.0.1:8080/
npm run test:ui      # headless Chromium smoke test of the page
```

Open the printed URL (`http://127.0.0.1:8080/`), press **Run**. The page offers
built-in synthetic sources (resonant tones, pulse trains, white/pink noise) or your
own files. Every stage can be soloed: donor, carrier, the excitation proxy, the
spectral stage before level normalisation, and the final output.

The page also has two host-facing surfaces, both driven by the same DSP kernel as
the tests:

- **Host automation — norm-control gain.** Write a gain point at a playhead time.
  If the donor has no valid source spectrum there (silence, or below the absolute
  support floor) the write is *rejected* or *parked* (your choice of policy) and the
  feedback line says which, and why. A parked write is released at the first valid
  frame, never inside the silent gap.
- **Open spectral editor…** picks two sources and a band-domain envelope-edit
  overlay, then renders cross-spectrum and shaped sound through the real kernel.
  The status line is built from that render (gain range, refused writes, output /
  carrier RMS), so a failure is visible rather than hidden.

If `npm run test:ui` cannot launch a browser in your environment (no Chromium
binary), start the server with `npm start` and open the URL; the automation and
editor compute paths are also covered headlessly by `npm test` through
`src/dsp/automation.js` and `src/dsp/editor.js`.

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
- **Silence and deep troughs.** A carrier frame whose loudest bin is numerical zero
  (or below `absoluteSupportFloorDb`) has no measurable content, so it is never
  declared excited — the relative bin-vs-peak test would otherwise read 0 dB and
  mark silence as fully excited. When the *donor* has no valid source spectrum for a
  frame, the normaliser write is refused (carrier passes through) or held to the last
  good frame (`lowEnergyPolicy`), and the fraction is reported. Donor time smoothing
  is reset at such a switch: the first valid frame after silence starts from its own
  measurement, not a floor-blurred one. The spectral-editor overlay and the host
  automation lane both obey this rule; a gain write during silence is parked or
  rejected and reported, never committed into the lane.

## Fixes in this revision

Three numerical defects in the low-energy path were found and fixed, each with a
regression test in `tests/lowenergy.test.js` and a checked-in golden file
(`tests/golden/envelope.json`) for the envelope / gain numbers:

- **Zero-frame over-excitation.** A frame peak of 0 made the relative support measure
  degenerate (`0 dB` below a zero peak), so digital silence read as fully excited and
  could receive positive gain. Fixed with an absolute support floor; silence now has
  zero excitation and writes no gain.
- **Degenerate `smoothstep`.** `excitationRangeDb <= 6` made the two edges coincide,
  producing `0/0` (NaN) in the support ramp. Now treated as a hard step.
- **Time bypass was a hole, not a pass-through.** Bypassed frames were handed to the
  synthesiser as *silent*, omitting them from the overlap-add sum, so the tail of a
  start-aligned bypass dropped to ~3% of the carrier instead of passing through.
  Bypassed frames now carry 0 dB and pass through as documented.

The spectral-edit overlay changes shape only (it is added before reference removal),
so an edit boosts or cuts a band without rescaling the whole output — no global gain
cut hides a local boom.

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
- Digital-silence frames are never excited and never boosted; a donor with no valid
  source spectrum refuses or parks the normaliser write and reports it to the
  automation lane; the low-energy history is reset at the switch; a deep carrier
  trough gets bounded local gain; time bypass passes the carrier through.
- The spectral editor renders through the same kernel: a +12 dB overlay moves the
  target shape by ~12 dB, and its status string is built from the kernel result.
- Envelope and cross-gain numbers match `tests/golden/envelope.json` (numeric
  regression, not a re-derivation).

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
src/dsp/presets.js    built-in donor/carrier presets shared by UI and tests
src/dsp/engine.js     cross-synthesis pipeline, gaps, audit, metrics, images
src/dsp/automation.js host automation lane: commit / park / refuse gain writes
src/dsp/editor.js     spectral-editor session (two sources + overlay -> kernel)
src/ui/               index.html, style.css, app.js (Web Audio playback + canvases)
tests/dsp.test.js     DSP test suite
tests/lowenergy.test.js  low-energy / trough regression suite
tests/golden/envelope.json  checked-in numeric regression values
tools/serve.mjs       dependency-free static server
tools/ui-smoke.mjs    headless Chromium smoke test
```
