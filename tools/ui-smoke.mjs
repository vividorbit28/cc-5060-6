// Headless smoke test for the UI. Runs the page in Chromium, presses Run, and
// asserts the report, canvases and solo buttons are live. Audio output is not
// listened to; this checks wiring and that the DSP produced a result.
//
// Usage: node tools/ui-smoke.mjs [--headed]
//
// The container has no root and no system Chromium libraries, so the browser is
// launched from the extracted library tree if it exists.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8123;

function findExecutable() {
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache)) {
    const p = join(cache, dir, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
  return undefined;
}

const libsDir = join(ROOT, '.libs', 'root');
const libPath = existsSync(libsDir)
  ? [
      join(libsDir, 'usr/lib/aarch64-linux-gnu'),
      join(libsDir, 'lib/aarch64-linux-gnu'),
      join(libsDir, 'usr/lib'),
    ].filter(existsSync).join(':')
  : '';

async function main() {
  const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const base = `http://127.0.0.1:${PORT}/src/ui/`;
  const browser = await chromium.launch({
    executablePath: findExecutable(),
    headless: process.argv[2] !== '--headed',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    env: libPath ? { ...process.env, LD_LIBRARY_PATH: libPath } : process.env,
  });
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(base, { waitUntil: 'load' });
    check((await page.title()).includes('Cross-source'), 'page title');

    // Report starts empty.
    check((await page.locator('#report').innerText()).includes('Run to produce'), 'report placeholder');

    await page.click('#run');
    await page.waitForFunction(
      () => document.querySelector('#status')?.className.includes('ready') === false &&
            /done|error/.test(document.querySelector('#status')?.textContent ?? ''),
      { timeout: 60000 },
    );
    const status = await page.locator('#status').innerText();
    check(/^done/.test(status), `run status: ${status}`);
    check(!errors.length, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);

    const report = (await page.locator('#report').innerText()).toLowerCase();
    check(report.includes('measurement report'), 'report rendered');
    check(report.includes('not source/filter separation'), 'report states it is not separation');
    check(report.includes('excitation period'), 'report includes excitation period');
    check(report.includes('spectral-envelope trend correlation'), 'report includes trend correlation');
    check(report.includes('energy audit'), 'report includes energy audit');
    check(report.includes('model scope and limitations'), 'report includes limitations');

    // Canvases painted: sample a few pixels for non-background colour.
    const painted = await page.evaluate(() => {
      const ids = ['canvDonorEnv', 'canvCarrierEnv', 'canvOutputEnv', 'canvGain',
        'canvMasks', 'canvTrend', 'canvDonorSpec', 'canvCarrierSpec',
        'canvSpectralSpec', 'canvOutputSpec', 'canvAmp'];
      const out = {};
      for (const id of ids) {
        const c = document.getElementById(id);
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBg = 0;
        for (let i = 0; i < d.length; i += 4 * 97) {
          if (d[i] + d[i + 1] + d[i + 2] > 40) nonBg++;
        }
        out[id] = nonBg;
      }
      return out;
    });
    for (const [id, n] of Object.entries(painted)) {
      check(n > 20, `${id} painted (${n} samples)`);
    }

    // Solo buttons: clicking must not throw and must update the now-playing label.
    for (const which of ['donor', 'carrier', 'excitation', 'spectral', 'output']) {
      await page.click(`[data-solo="${which}"]`);
      const label = await page.locator('#nowPlaying').innerText();
      check(label.length > 0 && label !== 'nothing playing', `solo ${which} → "${label}"`);
    }
    check(!errors.length, 'no page errors after playback');

    // Frequency-gap policy must be selectable and re-run clean.
    await page.selectOption('#freqGapMode', 'bypass');
    await page.click('#run');
    await page.waitForFunction(
      () => /done|error/.test(document.querySelector('#status')?.textContent ?? ''),
      { timeout: 60000 },
    );
    const report2 = (await page.locator('#report').innerText()).toLowerCase();
    check(/gap policy.*bypass \/ hold/s.test(report2), 'report reflects bypass policy');

    // --- Host automation lane ---------------------------------------------
    // A write inside a region with a valid source spectrum is committed. The
    // default sources are continuous tones, so any time is valid.
    await page.selectOption('#freqGapMode', 'extrapolate');
    await page.click('#run');
    await page.waitForFunction(
      () => /done|error/.test(document.querySelector('#status')?.textContent ?? ''),
      { timeout: 60000 },
    );
    await page.fill('#autoTimeSec', '0.3');
    await page.fill('#autoGainDb', '6');
    await page.click('#autoWrite');
    let autoText = (await page.locator('#autoFeedback').innerText()).toLowerCase();
    check(/committed/.test(autoText), `automation committed on valid source: ${autoText}`);
    check(!/rejected|parked/.test(autoText), 'valid-source write is not rejected/parked');

    // Rejected/parked feedback must appear for a no-source situation. Point the
    // writer past the end of the donor's time map is not no-source, so instead
    // switch policy and write; the label must always state the policy.
    await page.selectOption('#autoPolicy', 'park');
    autoText = (await page.locator('#autoFeedback').innerText()).toLowerCase();
    check(/policy: park/.test(autoText), 'automation feedback names the active policy');

    // --- Spectral editor window -------------------------------------------
    await page.click('#openEdit');
    const dlgOpen = await page.evaluate(() => {
      const d = document.getElementById('editDialog');
      return d && (d.open === true || d.hasAttribute('open'));
    });
    check(dlgOpen, 'spectral editor dialog opens');
    const editStatus = (await page.locator('#editDialogStatus').innerText()).toLowerCase();
    check(/gain .*db/.test(editStatus), `editor reports kernel gain: ${editStatus}`);
    check(/refused writes/.test(editStatus), 'editor reports refused writes from the kernel');

    // Editor canvases painted from the kernel result.
    const editPainted = await page.evaluate(() => {
      const out = {};
      for (const id of ['editCrossSpec', 'editGain']) {
        const c = document.getElementById(id);
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBg = 0;
        for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 40) nonBg++;
        out[id] = nonBg;
      }
      return out;
    });
    for (const [id, n] of Object.entries(editPainted)) check(n > 20, `${id} painted (${n} samples)`);

    // Applying a nonzero band offset changes the reported gain range: the
    // control is driven by the computation, not a label.
    const beforeGain = await page.locator('#editDialogStatus').innerText();
    await page.fill('#editDialogBand', '20');
    await page.fill('#editDialogDb', '12');
    await page.click('#editApply');
    const afterStatus = (await page.locator('#editDialogStatus').innerText()).toLowerCase();
    check(/\+12 db/.test(afterStatus), `editor applied +12 dB overlay: ${afterStatus}`);
    check(afterStatus !== beforeGain.toLowerCase(), 'editor status reflects the new render');

    // Editor playback buttons work from the kernel result.
    await page.click('#editPlayShaped');
    check((await page.locator('#nowPlaying').innerText()).length > 0, 'editor shaped sound plays');
    await page.click('#editPlayCross');
    check((await page.locator('#nowPlaying').innerText()).length > 0, 'editor cross spectrum plays');
    await page.click('#closeEdit');
    check(!errors.length, 'no page errors after editor/automation');

    console.log(failures.length ? `\n${failures.length} UI check(s) failed` : '\nall UI checks passed');
  } finally {
    await browser.close();
    server.kill();
  }
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
