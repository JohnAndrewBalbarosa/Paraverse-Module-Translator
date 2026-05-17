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
const { chromium } = require("playwright");

require("dotenv").config();

const PARAVERSE_URL =
  process.env.CURRICULUM_URL || "https://paraverse.feutech.edu.ph/network-map/curriculum/";
const COOKIES_PATH = path.resolve(process.cwd(), "cookies.json");
const PROFILE_DIR = path.resolve(process.cwd(), "sessions", "profile");
const MFA_WAIT_MS = 5 * 60 * 1000;
const STEP_TIMEOUT_MS = 30 * 1000;

const CHAR_CTRL_C = String.fromCharCode(3);
const CHAR_BACKSPACE = String.fromCharCode(127);

function log(msg) {
  stderr.write(`[login] ${msg}\n`);
}

function loud(msg) {
  stderr.write(`\n[login] *** ${msg} ***\n\n`);
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
  return /paraverse\.feutech\.edu\.ph/.test(page.url());
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

  while (Date.now() - start < MFA_WAIT_MS) {
    if (await isOnParaverse(page)) return "success";

    const headerText = (await safeText(page.locator("#loginHeader"))) || "";
    if (/incorrect|wrong password|denied|verify your identity/i.test(headerText)) {
      const detail =
        (await safeText(page.locator("#passwordError, #usernameError, .alert-error"))) || headerText;
      throw new Error(`Sign-in rejected: ${detail || headerText}`);
    }

    const num =
      (await safeText(page.locator("#idRichContext_DisplaySign"))) ||
      (await safeText(page.locator(".displaySign")));
    if (num && num !== lastNumber) {
      lastNumber = num;
      loud(`Tap ${num} in your Microsoft Authenticator app`);
    } else if (!num && !warnedNoNumber && /approve/i.test(headerText)) {
      warnedNoNumber = true;
      loud("Approve the sign-in request in your Microsoft Authenticator app.");
    }

    if (/stay signed in/i.test(headerText)) {
      log('Auto-accepting "Stay signed in".');
      await page.click("#idSIButton9").catch(() => {});
    }

    await page.waitForTimeout(2000);
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
    viewport: { width: 1366, height: 900 }
  });
  const page = await context.newPage();

  try {
    await page.goto(PARAVERSE_URL, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS });

    if (await isOnParaverse(page)) {
      log("Session still valid — no Microsoft prompt needed.");
    } else {
      log("Redirected to Microsoft sign-in.");
      const pickedExisting = await tryClickAccountTile(page, username);
      if (!pickedExisting) {
        await submitEmail(page, username);
      }
      await submitPassword(page, password);
      await waitForMfaOrSuccess(page);
    }

    await page.waitForURL(/paraverse\.feutech\.edu\.ph/, { timeout: 60000 });
    await page.waitForLoadState("domcontentloaded");

    const count = await harvestCookies(context);
    log(`Saved ${count} cookie(s) to ${COOKIES_PATH}`);
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
