// Pixel Web — free scheduled SIP wake-up call (GitHub Actions + Playwright).
// Opens https://call.shanto.info/, registers the SIP account, calls the number,
// waits, and reports whether the wake-up message actually travelled (outbound packets).
// The call lasts as long as possible: if it is not answered, or ends early,
// it redials (up to CALL_ATTEMPTS times), and the message loops on the page
// for the whole connected call, up to TALK_SECONDS after answer.
// Credentials come ONLY from environment variables (GitHub Secrets) — never hardcode.
const { chromium } = require('playwright');

const SIP_USER = process.env.SIP_USER || '';
const SIP_PASS = process.env.SIP_PASS || '';
const SIP_SERVER = process.env.SIP_SERVER || '103.170.231.10';
const SIP_PORT = process.env.SIP_PORT || '5060';
const CALL_NUMBER = process.env.CALL_NUMBER || '01319779498';
const TALK_SECONDS = parseInt(process.env.TALK_SECONDS || '120', 10);
const CALL_ATTEMPTS = parseInt(process.env.CALL_ATTEMPTS || '3', 10);
const PAGE_URL = process.env.PAGE_URL || 'https://call.shanto.info/';

const RING_WAIT_SECONDS = 75;    // max ringing per attempt
const REDIAL_PAUSE_SECONDS = 5;  // pause between attempts
const MIN_HEARD_SECONDS = 30;    // answered + verified + up this long = heard (no redial if they hang up)

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;

async function dumpPageState(tag) {
  if (!page) return;
  try {
    console.log(`--- page state (${tag}) ---`);
    console.log('status:', (await page.textContent('#status', { timeout: 5000 }).catch(() => '(n/a)')) || '(empty)');
    console.log('promo:', (await page.textContent('#promoStatus', { timeout: 5000 }).catch(() => '(n/a)')) || '(empty)');
    const log = (await page.textContent('#log', { timeout: 5000 }).catch(() => '')) || '';
    console.log('log (last 3000 chars):\n' + log.slice(-3000));
  } catch (e) { console.log('dump failed:', String(e).slice(0, 200)); }
  try {
    await page.screenshot({ path: 'failure.png' });
    console.log('saved screenshot failure.png');
  } catch (e) { console.log('screenshot failed:', String(e).slice(0, 200)); }
}

async function getStatus() {
  return (await page.textContent('#status', { timeout: 5000 }).catch(() => '')) || '';
}

function callEnded(statusText) {
  const s = (statusText || '').toLowerCase();
  return s.includes('ended') || s.includes('failed') || s.includes('terminated');
}

// Voice travelled only if outbound audio packets actually grew.
async function verifyVoice() {
  const log = (await page.textContent('#log', { timeout: 5000 }).catch(() => '')) || '';
  const promoStatus = (await page.textContent('#promoStatus', { timeout: 5000 }).catch(() => '')) || '';
  console.log('--- promo status ---\n' + promoStatus);
  console.log('--- page log ---\n' + log);
  const checks = [...log.matchAll(/(\d+) packets \/ (\d+) bytes sent/g)];
  const last = checks.length ? checks[checks.length - 1] : null;
  const sent = last ? parseInt(last[1], 10) : 0;
  const mediaFailed = /Media path is NOT up/i.test(log) || /CANNOT hear/i.test(log);
  console.log(`RESULT: outbound_packets=${sent} media_failed=${mediaFailed}`);
  return { ok: sent > 0 && !mediaFailed, sent, mediaFailed };
}

async function waitForCallReady() {
  for (let i = 0; i < 15; i++) {
    if (await page.isEnabled('#callBtn').catch(() => false)) return true;
    await sleep(1000);
  }
  return false;
}

(async () => {
  if (!SIP_USER || !SIP_PASS) {
    console.error('MISSING SECRETS: set SIP_USER and SIP_PASS (GitHub Secrets).');
    process.exit(2);
  }
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    });
    page = await browser.newPage();
    page.on('console', (m) => console.log(`[page console ${elapsed()}]`, m.type(), m.text().slice(0, 300)));
    page.on('pageerror', (e) => console.log(`[pageerror ${elapsed()}]`, String(e).slice(0, 300)));

    console.log(`[${elapsed()}] Opening`, PAGE_URL);
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('#registerBtn', { timeout: 30000 });
    console.log(`[${elapsed()}] Page loaded, form found`);

    // Fill the connection form from secrets/env.
    await page.fill('#server', SIP_SERVER);
    await page.fill('#port', SIP_PORT);
    await page.fill('#username', SIP_USER);
    await page.fill('#password', SIP_PASS);
    await page.fill('#number', CALL_NUMBER);

    console.log(`[${elapsed()}] Registering as`, SIP_USER);
    await page.click('#registerBtn');
    try {
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent?.includes('Registered'),
        { timeout: 60000 }
      );
      console.log(`[${elapsed()}] REGISTERED`);
    } catch {
      console.error(`[${elapsed()}] REGISTER FAILED — status:`, await page.textContent('#status'));
      await dumpPageState('register-failed');
      process.exitCode = 1;
      return;
    }

    let success = false;
    for (let attempt = 1; attempt <= CALL_ATTEMPTS && !success; attempt++) {
      if (!(await waitForCallReady())) {
        console.error(`[${elapsed()}] Attempt ${attempt}: Call button never became ready.`);
        break;
      }
      console.log(`[${elapsed()}] Calling ${CALL_NUMBER} (attempt ${attempt}/${CALL_ATTEMPTS})`);
      await page.click('#callBtn');

      // Wait for answer (up to RING_WAIT_SECONDS of ringing).
      let answered = false;
      for (let i = 0; i < RING_WAIT_SECONDS; i++) {
        const st = await getStatus();
        if (st.toLowerCase().includes('answered')) { answered = true; break; }
        if (callEnded(st)) break;
        await sleep(1000);
      }
      if (!answered) {
        console.error(`[${elapsed()}] Attempt ${attempt}: no answer (call ended while ringing or ring timeout).`);
        if (attempt < CALL_ATTEMPTS) {
          console.log(`[${elapsed()}] Redialing in ${REDIAL_PAUSE_SECONDS}s…`);
          await sleep(REDIAL_PAUSE_SECONDS * 1000);
        }
        continue;
      }

      console.log(`[${elapsed()}] ANSWERED (attempt ${attempt}) — message loops for up to`, TALK_SECONDS, 's');
      // Stay on the call up to TALK_SECONDS, watching for an early end.
      let outcome = 'talked'; // 'talked' | 'heard-hangup' | 'ended-early'
      for (let t = 0; t < TALK_SECONDS; t += 5) {
        await sleep(5000);
        const st = await getStatus();
        if (callEnded(st)) {
          const promoStatus = (await page.textContent('#promoStatus', { timeout: 5000 }).catch(() => '')) || '';
          const verified = /verified/i.test(promoStatus);
          const upSeconds = t + 5;
          if (verified && upSeconds >= MIN_HEARD_SECONDS) {
            console.log(`[${elapsed()}] Callee hung up after ${upSeconds}s (voice verified) — counts as heard.`);
            outcome = 'heard-hangup';
          } else {
            console.error(`[${elapsed()}] Call ended early after ${upSeconds}s (verified=${verified}) — will redial.`);
            outcome = 'ended-early';
          }
          break;
        }
      }
      if (outcome === 'ended-early') {
        if (attempt < CALL_ATTEMPTS) {
          console.log(`[${elapsed()}] Redialing in ${REDIAL_PAUSE_SECONDS}s…`);
          await sleep(REDIAL_PAUSE_SECONDS * 1000);
        }
        continue;
      }
      if (outcome === 'talked') {
        const hangupEnabled = await page.isEnabled('#hangupBtn').catch(() => false);
        if (hangupEnabled) await page.click('#hangupBtn').catch(() => {});
        await sleep(2000);
      }
      // Verify the voice travelled on this attempt.
      const v = await verifyVoice();
      if (v.ok) {
        console.log('VOICE CONFIRMED: wake-up message reached the gateway.');
        success = true;
      } else {
        console.error('VOICE NOT CONFIRMED: no outbound audio packets — the callee heard nothing.');
        if (attempt < CALL_ATTEMPTS) {
          console.log(`[${elapsed()}] Redialing in ${REDIAL_PAUSE_SECONDS}s…`);
          await sleep(REDIAL_PAUSE_SECONDS * 1000);
        }
      }
    }

    if (!success) {
      console.error(`[${elapsed()}] FAILED after ${CALL_ATTEMPTS} attempt(s).`);
      await dumpPageState('call-failed');
      process.exitCode = 1;
      return;
    }
  } catch (e) {
    console.error(`[${elapsed()}] SCRIPT ERROR:`, e);
    await dumpPageState('script-error');
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
