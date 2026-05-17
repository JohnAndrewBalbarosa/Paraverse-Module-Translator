const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

async function main() {
  const profileDir = path.resolve(process.cwd(), "sessions", "profile");
  const recordingsDir = path.resolve(process.cwd(), "recordings");
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionDir = path.join(recordingsDir, sessionId);
  const videoDir = path.join(sessionDir, "video");
  const tracePath = path.join(sessionDir, "trace.zip");
  const outFile = path.resolve(process.cwd(), "recorded.js");

  fs.mkdirSync(videoDir, { recursive: true });

  const startUrl =
    process.argv[2] || "https://paraverse.feutech.edu.ph/network-map/curriculum/";

  console.log(`[record] Persistent profile: ${profileDir}`);
  console.log(`[record] Session folder:    ${sessionDir}`);
  console.log(`[record] Opening:           ${startUrl}`);
  console.log("[record] Recording: video + trace + Playwright code");
  console.log("[record] Click around freely. Close the browser when done.\n");

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1366, height: 900 },
    recordVideo: {
      dir: videoDir,
      size: { width: 1366, height: 900 }
    }
  });

  // Trace = step-by-step screenshots, DOM snapshots, network, console.
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true
  });

  // Live Playwright code generation.
  await context._enableRecorder({
    language: "javascript",
    mode: "recording",
    outputFile: outFile,
    launchOptions: {},
    contextOptions: {}
  }).catch((err) => {
    console.warn("[record] Code recorder unavailable:", err.message);
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

  // Wait until user closes the browser.
  await new Promise((resolve) => context.on("close", resolve));

  // After close, finalize trace + video.
  await context.tracing.stop({ path: tracePath }).catch(() => {});

  if (fs.existsSync(outFile)) {
    rewriteForPersistentContext(outFile);
  }

  // Find video files (they are saved with random names by Playwright).
  const videoFiles = fs.existsSync(videoDir)
    ? fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm"))
    : [];

  console.log("\n[record] Done.");
  console.log(`[record]   Code:   ${outFile}`);
  console.log(`[record]   Trace:  ${tracePath}`);
  if (videoFiles.length) {
    for (const v of videoFiles) {
      console.log(`[record]   Video:  ${path.join(videoDir, v)}`);
    }
  } else {
    console.log("[record]   Video:  (no video captured)");
  }
  console.log("\n[record] To replay the trace step-by-step:");
  console.log(`         npx playwright show-trace "${tracePath}"`);
}

function rewriteForPersistentContext(file) {
  const original = fs.readFileSync(file, "utf8");

  const bodyMatch = original.match(/\(async \(\) => \{([\s\S]*?)\}\)\(\);?\s*$/);
  if (!bodyMatch) return;

  let body = bodyMatch[1];

  body = body
    .replace(/^\s*const browser = await chromium\.launch\([^)]*\);?\s*$/m, "")
    .replace(/^\s*const context = await browser\.newContext\([^)]*\);?\s*$/m, "")
    .replace(/^\s*await context\.close\(\);?\s*$/m, "")
    .replace(/^\s*await browser\.close\(\);?\s*$/m, "");

  const usesPage = /\bpage\./.test(body);
  const declaresPage = /const\s+page\s*=/.test(body);
  if (usesPage && !declaresPage) {
    body = `\n  const page = context.pages()[0] || (await context.newPage());${body}`;
  }

  const rewritten = `const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const profileDir = path.resolve(process.cwd(), "sessions", "profile");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1366, height: 900 }
  });
${body.trimEnd()}

  await context.close();
})();
`;

  fs.writeFileSync(file, rewritten, "utf8");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
