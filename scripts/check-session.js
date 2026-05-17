#!/usr/bin/env node
const path = require("path");
const fs = require("fs");
const { createHttpClient, SessionExpiredError } = require("../src/httpClient");
const { loadCookies, writeNetscapeFile, DEFAULT_COOKIES_PATH } = require("../src/cookieJar");

const CURRICULUM_URL = process.env.CURRICULUM_URL || "https://paraverse.feutech.edu.ph/network-map/curriculum/";

async function main() {
  const args = process.argv.slice(2);
  const emitCurl = args.includes("--emit-curl");

  let http;
  try {
    http = createHttpClient();
  } catch (err) {
    console.error(`[check-session] ${err.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const html = await http.fetchHtml(CURRICULUM_URL);
    console.log(`[check-session] OK — fetched ${html.length} bytes from ${CURRICULUM_URL}`);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.error(`[check-session] EXPIRED — ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(`[check-session] FAIL — ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (emitCurl) {
    const cookies = loadCookies();
    const netscapePath = path.resolve(process.cwd(), "cookies.txt");
    writeNetscapeFile(cookies, netscapePath);
    console.log(`[check-session] Wrote curl-compatible jar: ${netscapePath}`);
    console.log(`[check-session] Try: curl -b "${netscapePath}" "${CURRICULUM_URL}" -o test.html`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
