const config = require("./config");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Translator } = require("./translator");
const headlessAdapter = require("./paraverseHeadless");
const { createHttpClient, SessionExpiredError } = require("./httpClient");
const { safeFileName } = require("./utils");

function parseArgs(argv) {
  return {
    loginOnly: argv.includes("--login-only")
  };
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
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const languageAnswer = await rl.question(
      `Target language (example: tl, en, tagalog)${defaults.targetLanguage ? ` [${defaults.targetLanguage}]` : ""}: `
    );

    const targetLanguage = (languageAnswer || defaults.targetLanguage || "tl").trim();
    const translationStyle = "";

    return { targetLanguage, translationStyle };
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
  await runHeadless(args);
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
