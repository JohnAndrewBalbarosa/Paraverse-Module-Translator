#!/usr/bin/env node
/**
 * Headless Microsoft sign-in for Paraverse.
 *
 * - No browser window appears (chromium runs with headless: true).
 * - Username + password collected from terminal (or .env).
 * - MFA number shown in terminal; you tap it in your Authenticator app.
 * - Cookies harvested to cookies.json on success.
 *
 * Subsequent runs reuse sessions/profile/ so Microsoft can skip MFA when
 * it trusts the device. Delete sessions/profile/ to force a fresh login.
 */
const fs = require("fs");
const path = require("path");
const readline = require("node:readline/promises");
const { stdin, stdout, stderr } = require("node:process");
const { URL } = require("node:url");
const { chromium } = require("playwright");

require("dotenv").config();

const PARAVERSE_URL =
  process.env.CURRICULUM_URL || "https://paraverse.feutech.edu.ph/network-map/curriculum/";
const COOKIES_PATH = path.resolve(process.cwd(), "cookies.json");
const PROFILE_DIR = path.resolve(process.cwd(), "sessions", "profile");
const MFA_WAIT_MS = 5 * 60 * 1000;
const STEP_TIMEOUT_MS = 30 * 1000;

// Must match src/httpClient.js DEFAULT_USER_AGENT so Incapsula's WAF doesn't
// invalidate the session when cookies move from Playwright to node-fetch.
const REAL_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const CHAR_CTRL_C = String.fromCharCode(3);
const CHAR_BACKSPACE = String.fromCharCode(127);

function log(msg) {
  stderr.write(`[login] ${msg}\n`);
}

function loud(msg) {
  stderr.write(`\n[login] *** ${msg} ***\n\n`);
}

function bigNumberBanner(number) {
  const bar = "=".repeat(60);
  const padded = `   TAP THIS NUMBER IN MICROSOFT AUTHENTICATOR:  ${number}   `;
  stderr.write(`\n${bar}\n${padded}\n${bar}\n\n`);
}

async function readMfaNumber(page) {
  const selectors = [
    "#idRichContext_DisplaySign",
    ".displaySign",
    "#displaySign",
    "[data-bind*='DisplaySign']",
    "div[role='heading'] + div b",
    "#idDiv_SAOTCAS_Description + div"
  ];
  for (const sel of selectors) {
    const txt = await safeText(page.locator(sel));
    const m = txt && txt.match(/\b(\d{2,3})\b/);
    if (m) return m[1];
  }
  return "";
}

async function promptUsername() {
  if (process.env.PARAVERSE_USERNAME) {
    log(`Using PARAVERSE_USERNAME from .env (${process.env.PARAVERSE_USERNAME}).`);
    return process.env.PARAVERSE_USERNAME.trim();
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("FEU Microsoft email: ")).trim();
    if (!answer) throw new Error("Email is required.");
    return answer;
  } finally {
    rl.close();
  }
}

function promptPassword() {
  if (process.env.PARAVERSE_PASSWORD) {
    log("Using PARAVERSE_PASSWORD from .env.");
    return Promise.resolve(process.env.PARAVERSE_PASSWORD);
  }
  return new Promise((resolve, reject) => {
    if (typeof stdin.setRawMode !== "function") {
      reject(new Error("Cannot mask password on this terminal. Set PARAVERSE_PASSWORD in .env instead."));
      return;
    }
    stdout.write("Password (hidden): ");
    let buf = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData);
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === CHAR_CTRL_C) {
          stdin.removeListener("data", onData);
          stdin.setRawMode(wasRaw);
          stdout.write("\n");
          reject(new Error("Aborted (Ctrl+C)."));
          return;
        }
        if (ch === CHAR_BACKSPACE || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (code < 32) continue;
        buf += ch;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function safeText(locator) {
  try {
    return ((await locator.first().textContent({ timeout: 500 })) || "").trim();
  } catch {
    return "";
  }
}

async function isOnParaverse(page) {
  try {
    const { hostname } = new URL(page.url());
    return hostname === "paraverse.feutech.edu.ph";
  } catch {
    return false;
  }
}

async function tryClickAccountTile(page, username) {
  try {
    const tiles = page.locator(`.tile[role="listitem"]`);
    const count = await tiles.count();
    for (let i = 0; i < count; i += 1) {
      const text = ((await tiles.nth(i).textContent()) || "").trim();
      if (text.toLowerCase().includes(username.toLowerCase())) {
        await tiles.nth(i).click();
        log("Picked existing account tile.");
        return true;
      }
    }
    for (let i = 0; i < count; i += 1) {
      const text = ((await tiles.nth(i).textContent()) || "").trim().toLowerCase();
      if (text.includes("use another account")) {
        await tiles.nth(i).click();
        log('Clicked "Use another account".');
        return false;
      }
    }
  } catch {
    // tile picker not present
  }
  return false;
}

async function submitEmail(page, username) {
  try {
    await page.waitForSelector('input[name="loginfmt"]', { timeout: 8000 });
  } catch {
    return false;
  }
  await page.fill('input[name="loginfmt"]', username);
  await page.click("#idSIButton9");
  log("Submitted email.");
  return true;
}

async function submitPassword(page, password) {
  await page.waitForSelector('input[name="passwd"]', { timeout: STEP_TIMEOUT_MS });
  await page.fill('input[name="passwd"]', password);
  await page.click("#idSIButton9").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  log("Submitted password.");
}

async function waitForMfaOrSuccess(page) {
  const start = Date.now();
  let lastNumber = "";
  let warnedNoNumber = false;
  let lastHeader = "";

  while (Date.now() - start < MFA_WAIT_MS) {
    if (await isOnParaverse(page)) return "success";

    const headerText = (await safeText(page.locator("#loginHeader"))) || "";
    if (headerText && headerText !== lastHeader) {
      log(`MS page: "${headerText}"`);
      lastHeader = headerText;
    }

    if (/incorrect|wrong password|denied|verify your identity/i.test(headerText)) {
      const detail =
        (await safeText(page.locator("#passwordError, #usernameError, .alert-error"))) || headerText;
      throw new Error(`Sign-in rejected: ${detail || headerText}`);
    }

    const num = await readMfaNumber(page);
    if (num && num !== lastNumber) {
      lastNumber = num;
      bigNumberBanner(num);
    } else if (!num && !warnedNoNumber && /approve/i.test(headerText)) {
      warnedNoNumber = true;
      loud("Approve the sign-in request in your Microsoft Authenticator app.");
    }

    if (/stay signed in/i.test(headerText)) {
      log('Auto-accepting "Stay signed in".');
      await page.click("#idSIButton9").catch(() => {});
    }

    await page.waitForTimeout(1000);
  }
  throw new Error(`MFA timeout (${MFA_WAIT_MS / 1000}s). Re-run: npm run login`);
}

async function harvestCookies(context) {
  const all = await context.cookies();
  const filtered = all.filter((c) => /feutech\.edu\.ph/.test(c.domain));
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(filtered, null, 2), "utf8");
  return filtered.length;
}

async function main() {
  const username = await promptUsername();
  const password = await promptPassword();

  log("Launching headless browser (no window will appear)...");
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1366, height: 900 },
    userAgent: REAL_CHROME_UA
  });
  const page = await context.newPage();

  try {
    await page.goto(PARAVERSE_URL, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });
    // Let the SSO redirect chain settle. waitUntil:"domcontentloaded" returns
    // on the first DOM event, which can be the MS login page mid-redirect.
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      // ignore — some MS pages keep network busy
    }

    if (await isOnParaverse(page)) {
      log("Silent SSO succeeded — no credentials needed.");
    } else {
      log("Microsoft sign-in required.");
      const pickedExisting = await tryClickAccountTile(page, username);
      if (!pickedExisting) {
        await submitEmail(page, username);
      }
      await submitPassword(page, password);
      await waitForMfaOrSuccess(page);
    }

    await page.waitForURL(/paraverse\.feutech\.edu\.ph/, { timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");

    // Verify auth actually works before saving. If Paraverse re-redirects to
    // MS here, our cookies will be stale-on-arrival to node-fetch.
    const verifyResp = await context.request.get(PARAVERSE_URL, { timeout: 20000 });
    const finalUrl = verifyResp.url();
    if (/login\.microsoftonline\.com/.test(finalUrl)) {
      throw new Error(
        `Auth verification failed — Paraverse keeps redirecting to Microsoft.\n` +
        `        This usually means silent SSO failed and you need to sign in with real credentials.\n` +
        `        Make sure PARAVERSE_USERNAME/PARAVERSE_PASSWORD in .env are correct, or remove them\n` +
        `        and re-run npm run login to be prompted interactively.\n` +
        `        Final URL was: ${finalUrl}`
      );
    }
    log(`Auth verified via Playwright (${verifyResp.status()} on ${finalUrl}).`);

    const count = await harvestCookies(context);
    log(`Saved ${count} cookie(s) to ${COOKIES_PATH}`);

    // Final smoke test: confirm the cookies + UA actually work over plain
    // node-fetch (this is what npm start uses). If this fails, the user-agent
    // or sec-fetch headers in src/httpClient.js don't match what Incapsula expects.
    try {
      const { createHttpClient, SessionExpiredError } = require("../src/httpClient");
      const http = createHttpClient();
      const html = await http.fetchHtml(PARAVERSE_URL);
      log(`Smoke test via node-fetch OK — ${html.length} bytes.`);
    } catch (err) {
      if (err && err.code === "SESSION_EXPIRED") {
        stderr.write(
          `\n[login] WARN: Cookies saved but node-fetch smoke test was redirected to MS.\n` +
          `         This means Incapsula sees node-fetch as a different client than the\n` +
          `         browser. Likely cause: User-Agent or Sec-Fetch-* header mismatch.\n` +
          `         The cookies file IS saved — try \`npm run check-session\` directly.\n`
        );
      } else {
        stderr.write(`\n[login] WARN: smoke test errored: ${err.message}\n`);
      }
    }

    log("Done. Next run: npm start (zero browser).");
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  stderr.write(`[login] FAILED: ${err.message}\n`);
  process.exitCode = 1;
});
