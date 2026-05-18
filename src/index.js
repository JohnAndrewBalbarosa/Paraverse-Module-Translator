/**
 * CLI entry point.
 *
 * Thin wrapper that:
 *   1. Parses CLI flags
 *   2. Builds an initial pipeline context (auth + cliArgs)
 *   3. For --use-saved, pre-populates downloadedModules from disk so the
 *      scrape/download stages skip themselves
 *   4. Selects a translator backend (manual is default)
 *   5. Hands off to runPipeline
 *
 * No business logic lives here. All transformation work is in stages.
 */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

const config = require("./config");
const { createHttpClient, SessionExpiredError } = require("./httpClient");
const { safeFileName } = require("./utils");
const translators = require("./translators");
const { runPipeline } = require("./pipeline");

function parseArgs(argv) {
  return {
    loginOnly: argv.includes("--login-only"),
    useSaved: argv.includes("--use-saved"),
    fresh: argv.includes("--fresh"),
    translate: argv.includes("--translate") || argv.includes("--translate-verify") || argv.includes("--render"),
    translateVerify: argv.includes("--translate-verify"),
    render: argv.includes("--render"),
    autoAll: argv.includes("--auto-all") || argv.includes("--translate-verify") || argv.includes("--render"),
    translator: pickOpt(argv, "--translator"),
    targetLang: pickOpt(argv, "--target-lang")
  };
}

function pickOpt(argv, name) {
  const prefix = `${name}=`;
  for (const a of argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return "";
}

function findSavedCourses(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(outputDir)) {
    const courseFolder = path.join(outputDir, name);
    if (!fs.statSync(courseFolder).isDirectory()) continue;
    const pdfDir = path.join(courseFolder, "pdf");
    if (!fs.existsSync(pdfDir)) continue;
    const pdfs = fs
      .readdirSync(pdfDir)
      // Only treat ORIGINAL downloaded assets as sources. The render stage
      // also writes `*.tl.pdf` (translated outputs) into this same folder;
      // those must NOT be re-fed as inputs to the extract stage or they'd
      // overwrite the translated JSONs.
      .filter((f) => /\.source\.(pdf|pptx?)$/i.test(f))
      .map((f) => path.join(pdfDir, f))
      .sort();
    if (pdfs.length === 0) continue;
    out.push({ courseFolder, courseName: name, pdfs });
  }
  return out;
}

async function promptStartupMode(savedCount, courseCount) {
  console.log("\n=== Paraverse Module Translator ===");
  console.log(`Found ${savedCount} previously-downloaded PDF(s) across ${courseCount} course(s) in output/.\n`);
  console.log("  1) Fresh login + scrape (download new PDFs, overwrites cache)");
  console.log("  2) Use saved PDFs only (skip login, just convert existing PDFs to JSON)");
  console.log("  3) Quit");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question("\nChoose [1-3]: ")).trim();
    if (answer === "2") return "use-saved";
    if (answer === "3") return "quit";
    return "fresh";
  } finally {
    rl.close();
  }
}

function buildContextFromSavedDisk(cliArgs) {
  // Skip discover/select/scrape/download by pre-populating downloadedModules.
  const saved = findSavedCourses(config.outputDir);
  if (!saved.length) return null;
  const downloadedModules = saved.map((s) => {
    const modules = s.pdfs.map((pdfPath) => {
      let base = path.basename(pdfPath, path.extname(pdfPath));
      base = base.replace(/\.source$/i, "");
      return {
        title: base,
        fileBase: base,
        ext: path.extname(pdfPath).replace(".", "").toLowerCase(),
        cachedPath: pdfPath,
        status: "ok-from-disk"
      };
    });
    return {
      course: { title: s.courseName },
      courseFolder: s.courseFolder,
      modules
    };
  });
  return {
    config,
    cliArgs,
    // Bypass-flags so the canSkip hooks fire for stages we don't need.
    curriculum: { skipped: true },
    selectedCourses: ["use-saved-mode"],
    scrapedModules: downloadedModules.map((d) => ({ course: d.course, modules: d.modules })),
    downloadedModules
  };
}

async function runLoginOnly() {
  let http;
  try {
    http = createHttpClient();
  } catch (err) {
    if (err.code === "COOKIES_MISSING" || err.code === "COOKIES_EMPTY" || err.code === "COOKIES_INVALID") {
      console.error(`[auth] ${err.message}`);
      console.error("[auth] Run: npm run login");
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  try {
    await http.fetchHtml(config.curriculumUrl);
    console.log("Session is valid. Cookies in cookies.json are working.");
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      console.error(`[auth] Session expired: ${err.message}`);
      console.error("[auth] Run: npm run login");
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));

  if (cliArgs.loginOnly) {
    await runLoginOnly();
    return;
  }

  // Decide mode: fresh download OR work from saved.
  let mode = "fresh";
  if (cliArgs.useSaved) mode = "use-saved";
  else if (cliArgs.fresh) mode = "fresh";
  else {
    const saved = findSavedCourses(config.outputDir);
    if (saved.length > 0) {
      const totalPdfs = saved.reduce((s, c) => s + c.pdfs.length, 0);
      mode = await promptStartupMode(totalPdfs, saved.length);
    }
  }

  if (mode === "quit") {
    console.log("Aborted.");
    return;
  }

  // Build pipeline deps.
  const log = (msg) => console.log(msg);

  // Translator backend selection. Precedence: CLI flag > env var > auto-default.
  const translatorName =
    cliArgs.translator ||
    config.translator ||
    translators.pickDefaultBackend(config);
  const translator = translators.create(translatorName, { config });

  // Build initial context.
  let initialContext;
  if (mode === "use-saved") {
    initialContext = buildContextFromSavedDisk(cliArgs);
    if (!initialContext) {
      console.error("[main] --use-saved requested but no saved PDFs found in output/.");
      process.exitCode = 1;
      return;
    }
    initialContext.translator = translator;
  } else {
    let http;
    try {
      http = createHttpClient();
    } catch (err) {
      if (err.code && err.code.startsWith("COOKIES_")) {
        console.error(`[auth] ${err.message}`);
        console.error("[auth] Run: npm run login");
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    initialContext = {
      config,
      cliArgs,
      http,
      translator
    };
  }

  try {
    await runPipeline(initialContext, { log });
  } catch (err) {
    if (err && err.code === "SESSION_EXPIRED") {
      console.error(`[auth] ${err.message}`);
      console.error("[auth] Run: npm run login");
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
