const config = require("./config");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Translator } = require("./translator");
const headlessAdapter = require("./paraverseHeadless");
const { createHttpClient, SessionExpiredError } = require("./httpClient");
const { safeFileName } = require("./utils");
const { writePdfJson } = require("./pdfToJson");

function parseArgs(argv) {
  return {
    loginOnly: argv.includes("--login-only"),
    useSaved: argv.includes("--use-saved"),
    fresh: argv.includes("--fresh")
  };
}

function findSavedPdfs(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  const courses = [];
  for (const courseName of fs.readdirSync(outputDir)) {
    const pdfDir = path.join(outputDir, courseName, "pdf");
    if (!fs.existsSync(pdfDir)) continue;
    const pdfs = fs
      .readdirSync(pdfDir)
      .filter((f) => /\.pdf$/i.test(f))
      .map((f) => path.join(pdfDir, f));
    if (pdfs.length) courses.push({ courseName, pdfDir, pdfs });
  }
  return courses;
}

async function promptStartupMode(savedSummary) {
  // Honor CLI flags first.
  // process.argv inspected outside — handled in main()
  const total = savedSummary.reduce((s, c) => s + c.pdfs.length, 0);
  console.log("\n=== Paraverse Module Translator ===");
  console.log(`Found ${total} previously-downloaded PDF(s) across ${savedSummary.length} course(s) in output/.\n`);
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

async function runUseSaved(savedSummary) {
  console.log("\n[saved] Converting saved PDFs to compact per-page JSON (no network calls).");
  let total = 0;
  let failed = 0;
  let totalBytes = 0;
  let totalPruned = 0;

  // Prune legacy files from EVERY course folder, including ones with zero PDFs
  // (e.g., courses where the module has no source PDF). cleanCourseFolder is a
  // no-op when nothing needs cleaning.
  if (fs.existsSync(config.outputDir)) {
    for (const name of fs.readdirSync(config.outputDir)) {
      const courseDir = path.join(config.outputDir, name);
      if (!fs.statSync(courseDir).isDirectory()) continue;
      totalPruned += headlessAdapter.cleanCourseFolder(courseDir);
    }
  }

  const manifest = [];
  for (const course of savedSummary) {
    const courseFolder = path.dirname(course.pdfDir);
    const jsonFolder = path.join(courseFolder, "json");
    console.log(`\n[saved] === ${course.courseName} (${course.pdfs.length} PDF(s)) -> json/ ===`);
    const moduleFiles = [];
    for (const pdfPath of course.pdfs) {
      // Strip the trailing ".source" if present so the JSON filename is clean.
      let base = path.basename(pdfPath, path.extname(pdfPath));
      base = base.replace(/\.source$/i, "");
      const jsonOut = path.join(jsonFolder, `${base}.json`);
      try {
        const r = await writePdfJson(pdfPath, jsonOut, {
          course: course.courseName,
          module: base
        }, { compact: true });
        const kb = (r.bytes / 1024).toFixed(1);
        console.log(`[saved]   OK   ${path.basename(jsonOut).padEnd(60)} ${r.pageCountAfterClean}p / ${r.lineCount}lines / ${kb}KB`);
        total += 1;
        totalBytes += r.bytes;
        moduleFiles.push({
          title: base,
          pdf: path.relative(courseFolder, pdfPath).split(path.sep).join("/"),
          json: path.relative(courseFolder, jsonOut).split(path.sep).join("/"),
          pageCount: r.pageCount,
          pageCountAfterClean: r.pageCountAfterClean,
          lineCount: r.lineCount,
          bytes: r.bytes,
          status: "ok"
        });
      } catch (err) {
        console.warn(`[saved]   FAIL ${path.basename(pdfPath)}: ${err.message}`);
        failed += 1;
        moduleFiles.push({
          title: base,
          pdf: path.relative(courseFolder, pdfPath).split(path.sep).join("/"),
          status: "json-failed",
          error: err.message
        });
      }
    }
    manifest.push({ course: { title: course.courseName }, moduleFiles });
  }

  const manifestPath = path.join(config.outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(`\n[saved] Done. ${total} JSON file(s) written (${(totalBytes / 1024).toFixed(1)} KB total), ${failed} failure(s), ${totalPruned} legacy file(s) pruned.`);
  console.log(`[saved] Manifest refreshed: ${manifestPath}`);
}

async function chooseCoursesForScrape(courses) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log("\n=== Course Selection (Current Term) ===");
    for (let i = 0; i < courses.length; i += 1) {
      console.log(`${i + 1}) ${courses[i].title}`);
    }
    console.log("Type course numbers separated by comma (example: 1,3,5) or press Enter for all.");
    const answer = (await rl.question("Select courses: ")).trim();
    if (!answer) {
      return courses;
    }

    const picks = answer
      .split(",")
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((v) => !Number.isNaN(v) && v >= 1 && v <= courses.length);

    const unique = [...new Set(picks)];
    if (!unique.length) {
      console.log("No valid selection detected. Defaulting to all current-term courses.");
      return courses;
    }

    const selected = unique.map((idx) => courses[idx - 1]);
    console.log(`Selected ${selected.length} course(s) for scraping.`);
    return selected;
  } finally {
    rl.close();
  }
}

function printScrapeSummary(scraped) {
  console.log("\n=== Scrape Summary ===");
  let totalModules = 0;
  let totalWithPdf = 0;
  for (let i = 0; i < scraped.length; i += 1) {
    const entry = scraped[i];
    const count = entry.modulePages.length;
    const withPdf = entry.modulePages.filter((m) => /\.(pdf|pptx?)(\?|$)/i.test(m.href || "")).length;
    totalModules += count;
    totalWithPdf += withPdf;
    const flag = withPdf < count ? ` [WARN: ${count - withPdf} without file URL]` : "";
    console.log(`${i + 1}. ${entry.course.title} -> ${count} module(s), ${withPdf} with PDF URL${flag}`);
  }
  console.log(`Total: ${totalModules} module(s), ${totalWithPdf} with downloadable URLs`);
}

function verifyOutputCounts(scraped, outputDir) {
  console.log("\n=== Verification: modules vs downloaded PDFs ===");
  let allMatch = true;
  for (const entry of scraped) {
    const moduleCount = entry.modulePages.length;
    const courseFolder = path.join(outputDir, safeFileName(entry.course.title || entry.course.href));
    const pdfDir = path.join(courseFolder, "pdf");
    let pdfCount = 0;
    if (fs.existsSync(pdfDir)) {
      pdfCount = fs.readdirSync(pdfDir).filter((f) => /\.(pdf|pptx?)$/i.test(f)).length;
    }
    const ok = pdfCount >= moduleCount;
    if (!ok) allMatch = false;
    const mark = ok ? "OK " : "FAIL";
    console.log(`  [${mark}] ${entry.course.title}: ${moduleCount} module(s) detected, ${pdfCount} file(s) downloaded`);
  }
  if (allMatch) {
    console.log("All courses: PDF count matches module count.");
  } else {
    console.log("WARNING: Some courses have fewer downloaded files than detected modules. Check logs above.");
  }
}

async function askTranslationPreferences(defaults) {
  // If TARGET_LANGUAGE is already set in .env, skip the prompt entirely.
  // Lets `npm start` run unattended for CI/monitoring scenarios.
  if (defaults.targetLanguage && String(defaults.targetLanguage).trim()) {
    return { targetLanguage: String(defaults.targetLanguage).trim(), translationStyle: "" };
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const languageAnswer = await rl.question(
      `Target language (example: tl, en, tagalog) [tl]: `
    );
    const targetLanguage = (languageAnswer || "tl").trim();
    return { targetLanguage, translationStyle: "" };
  } finally {
    rl.close();
  }
}

async function runHeadless(args) {
  let http;
  try {
    http = createHttpClient();
  } catch (err) {
    if (err.code === "COOKIES_MISSING" || err.code === "COOKIES_EMPTY" || err.code === "COOKIES_INVALID") {
      console.error(`\n[auth] ${err.message}`);
      console.error("[auth] See docs/sign-in.md (or run: npm run login), then re-run.");
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (args.loginOnly) {
    try {
      await http.fetchHtml(config.curriculumUrl);
      console.log("Session is valid. Cookies in cookies.json are working.");
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        console.error(`\n[auth] Session expired: ${err.message}`);
        console.error("[auth] Refresh cookies.json — see docs/sign-in.md (or run: npm run login).");
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  const nodes = await headlessAdapter.loadCurriculumCourses(http, config.curriculumUrl);
  if (!nodes.length) {
    throw new Error("No course nodes found on curriculum page. Cookies may be valid but page structure changed.");
  }

  const columns = headlessAdapter.clusterByColumn(nodes);
  const currentTerm = config.studentMode === "regular"
    ? headlessAdapter.pickCurrentTermForRegular(columns)
    : headlessAdapter.pickCurrentTermForIrregular(columns);

  if (!currentTerm) {
    throw new Error(
      `Could not determine current term for mode: ${config.studentMode}. ` +
      "Switch STUDENT_MODE or update term detection in src/htmlExtract.js."
    );
  }

  const uniqueCourses = [];
  const seen = new Set();
  for (const course of currentTerm.nodes) {
    const key = course.courseCode || course.href || course.title;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCourses.push(course);
    }
  }

  console.log(`Detected term column #${currentTerm.index + 1} with ${uniqueCourses.length} course(s).`);

  const selectedCourses = await chooseCoursesForScrape(uniqueCourses);

  const scraped = await headlessAdapter.scrapeModulesForCourses(http, selectedCourses, {
    scanMode: "strict",
    curriculumUrl: config.curriculumUrl,
    curriculumCode: config.curriculumCode
  });

  printScrapeSummary(scraped);

  const preferences = await askTranslationPreferences({
    targetLanguage: config.targetLanguage,
    translationStyle: config.translationStyle
  });

  const createTranslator = () => new Translator({
    targetLanguage: preferences.targetLanguage,
    style: preferences.translationStyle,
    researchProvider: config.researchProvider,
    researchApiKey: config.researchApiKey,
    researchBaseUrl: config.researchBaseUrl,
    researchModel: config.researchModel,
    disableCache: true
  });

  const manifestPath = await headlessAdapter.exportTranslatedHtml(
    config.outputDir,
    scraped,
    createTranslator,
    { requestContext: http.asRequestContextShim() }
  );

  verifyOutputCounts(scraped, config.outputDir);

  console.log("\nDone.");
  console.log(`Manifest: ${manifestPath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --login-only short-circuits to the auth check, no prompts.
  if (args.loginOnly) {
    return runHeadless(args);
  }

  const savedSummary = findSavedPdfs(config.outputDir);
  let mode = "fresh";
  if (args.useSaved) {
    mode = "use-saved";
  } else if (args.fresh) {
    mode = "fresh";
  } else if (savedSummary.length > 0) {
    mode = await promptStartupMode(savedSummary);
  }

  if (mode === "quit") {
    console.log("Aborted.");
    return;
  }
  if (mode === "use-saved") {
    if (!savedSummary.length) {
      console.error("[saved] No saved PDFs found in output/. Run without --use-saved to download first.");
      process.exitCode = 1;
      return;
    }
    return runUseSaved(savedSummary);
  }
  return runHeadless(args);
}

main().catch((err) => {
  if (err && err.code === "SESSION_EXPIRED") {
    console.error(`\n[auth] ${err.message}`);
    console.error("[auth] Refresh cookies.json — see docs/sign-in.md (or run: npm run login).");
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
