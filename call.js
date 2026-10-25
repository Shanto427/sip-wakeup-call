// Pixel Web — free scheduled SIP wake-up / promo call (GitHub Actions + Playwright).
// Opens https://sip.shanto.info/, registers the SIP account, calls the number,
// waits, and reports whether the promo voice actually travelled (outbound packets).
// Credentials come ONLY from environment variables (GitHub Secrets) — never hardcode.
const { chromium } = require('playwright');

const SIP_USER = process.env.SIP_USER || '';
const SIP_PASS = process.env.SIP_PASS || '';
const SIP_SERVER = process.env.SIP_SERVER || '103.170.231.10';
const SIP_PORT = process.env.SIP_PORT || '5060';
const CALL_NUMBER = process.env.CALL_NUMBER || '01319779498';
const TALK_SECONDS = parseInt(process.env.TALK_SECONDS || '65', 10);
const PAGE_URL = process.env.PAGE_URL || 'https://sip.shanto.info/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!SIP_USER || !SIP_PASS) {
    console.error('MISSING SECRETS: set SIP_USER and SIP_PASS (GitHub Secrets).');
    process.exit(2);
  }
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  try {
    console.log('Opening', PAGE_URL);
    await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('#registerBtn', { timeout: 30000 });

    // Fill the connection form from secrets/env.
    await page.fill('#server', SIP_SERVER);
    await page.fill('#port', SIP_PORT);
    await page.fill('#username', SIP_USER);
    await page.fill('#password', SIP_PASS);
    await page.fill('#number', CALL_NUMBER);

    console.log('Registering as', SIP_USER);
    await page.click('#registerBtn');
    try {
      await page.waitForFunction(
        () => document.querySelector('#status')?.textContent?.includes('Registered'),
        { timeout: 60000 }
      );
      console.log('REGISTERED');
    } catch {
      console.error('REGISTER FAILED — status:', await page.textContent('#status'));
      console.log('--- page log ---\n' + (await page.textContent('#log')));
      process.exitCode = 1;
      return;
    }

    console.log('Calling', CALL_NUMBER);
    await page.click('#callBtn');

    // Wait for answer (up to 75s of ringing), then let the promo play.
    let answered = false;
    for (let i = 0; i < 75; i++) {
      const status = (await page.textContent('#status')) || '';
      if (status.toLowerCase().includes('answered')) { answered = true; break; }
      if (status.toLowerCase().includes('ended') || status.toLowerCase().includes('failed')) break;
      await sleep(1000);
    }
    if (!answered) {
      console.error('NO ANSWER (or call ended while ringing).');
      console.log('--- page log ---\n' + (await page.textContent('#log')));
      process.exitCode = 1;
      return;
    }
    console.log('ANSWERED — letting the promo play for', TALK_SECONDS, 's');
    await sleep(TALK_SECONDS * 1000);

    const hangupEnabled = await page.isEnabled('#hangupBtn').catch(() => false);
    if (hangupEnabled) await page.click('#hangupBtn').catch(() => {});
    await sleep(2000);

    const log = (await page.textContent('#log')) || '';
    const promoStatus = (await page.textContent('#promoStatus')) || '';
    console.log('--- promo status ---\n' + promoStatus);
    console.log('--- page log ---\n' + log);

    // Voice travelled only if outbound audio packets actually grew.
    const checks = [...log.matchAll(/(\d+) packets \/ (\d+) bytes sent/g)];
    const last = checks.length ? checks[checks.length - 1] : null;
    const sent = last ? parseInt(last[1], 10) : 0;
    const mediaFailed = /Media path is NOT up/i.test(log) || /CANNOT hear/i.test(log);
    console.log(`RESULT: answered=${answered} outbound_packets=${sent} media_failed=${mediaFailed}`);
    if (answered && sent > 0 && !mediaFailed) {
      console.log('VOICE CONFIRMED: promo audio reached the gateway.');
      process.exitCode = 0;
    } else {
      console.error('VOICE NOT CONFIRMED: no outbound audio packets — the callee heard nothing.');
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => {
  console.error('SCRIPT ERROR:', e);
  process.exit(1);
});
