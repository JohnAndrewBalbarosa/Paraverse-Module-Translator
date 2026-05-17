const config = require("./config");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Translator } = require("./translator");
const { observerMode } = require("./observer");
const browserAdapter = require("./paraverse");
const headlessAdapter = require("./paraverseHeadless");
const { createHttpClient, SessionExpiredError } = require("./httpClient");

function parseArgs(argv) {
  return {
    loginOnly: argv.includes("--login-only"),
    observe: argv.includes("--observe"),
    useBrowser: argv.includes("--use-browser")
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

function buildStrictRelaxedAudit(strictScraped, relaxedScraped) {
  const relaxedByCourse = new Map(relaxedScraped.map((entry) => [entry.course.href, entry]));
  const courses = [];

  for (const strictEntry of strictScraped) {
    const relaxedEntry = relaxedByCourse.get(strictEntry.course.href);
    const strictLinks = strictEntry.modulePages.map((m) => m.href);
    const relaxedLinks = (relaxedEntry?.modulePages || []).map((m) => m.href);

    const strictSet = new Set(strictLinks);
    const relaxedSet = new Set(relaxedLinks);

    const extraInRelaxed = relaxedLinks.filter((href) => !strictSet.has(href));
    const missingInRelaxed = strictLinks.filter((href) => !relaxedSet.has(href));

    courses.push({
      courseTitle: strictEntry.course.title,
      courseUrl: strictEntry.course.href,
      strictCount: strictLinks.length,
      relaxedCount: relaxedLinks.length,
      extraInRelaxed,
      missingInRelaxed
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    strictCourseCount: strictScraped.length,
    relaxedCourseCount: relaxedScraped.length,
    courses
  };
}

function writeAuditFile(outputDir, auditData) {
  const filePath = path.join(outputDir, "audit-strict-vs-relaxed.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(auditData, null, 2), "utf8");
  return filePath;
}

function printScrapeSummary(scraped, scanMode) {
  console.log("\n=== Scrape Summary ===");
  console.log(`Scan mode: ${scanMode}`);
  let totalModules = 0;
  for (let i = 0; i < scraped.length; i += 1) {
    const entry = scraped[i];
    const count = entry.modulePages.length;
    totalModules += count;
    console.log(`${i + 1}. ${entry.course.title} -> ${count} module page(s)`);
  }
  console.log(`Total module pages: ${totalModules}`);
}

function printDetailedModules(scraped) {
  console.log("\n=== Detailed Modules ===");
  for (let i = 0; i < scraped.length; i += 1) {
    const entry = scraped[i];
    console.log(`\n[${i + 1}] ${entry.course.title}`);
    for (let j = 0; j < entry.modulePages.length; j += 1) {
      const module = entry.modulePages[j];
      const status = module.error ? `ERROR: ${module.error}` : "OK";
      console.log(`  - (${j + 1}) ${module.title} | ${status}`);
      console.log(`    ${module.href}`);
    }
  }
}

async function validateExpectedCounts(scraped, rl) {
  console.log("\nEnter expected module count per course. Leave blank to skip a course.");
  const issues = [];
  for (let i = 0; i < scraped.length; i += 1) {
    const entry = scraped[i];
    const answer = await rl.question(`Expected modules for ${entry.course.title}: `);
    const trimmed = answer.trim();
    if (!trimmed) {
      continue;
    }

    const expected = Number.parseInt(trimmed, 10);
    if (Number.isNaN(expected) || expected < 0) {
      issues.push(`Invalid expected count for ${entry.course.title}`);
      continue;
    }

    const found = entry.modulePages.length;
    if (found < expected) {
      issues.push(`${entry.course.title}: expected at least ${expected}, found ${found}`);
    }
  }

  if (!issues.length) {
    console.log("Validation passed: no missing module warning based on your inputs.");
  } else {
    console.log("Validation warnings:");
    for (const issue of issues) {
      console.log(`- ${issue}`);
    }
  }
}

async function reviewScrapeMenu(context, courses, initialScraped) {
  let scraped = initialScraped;
  let scanMode = initialScraped[0]?.scanMode || "strict";

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    let done = false;
    while (!done) {
      printScrapeSummary(scraped, scanMode);
      console.log("\nMenu:");
      console.log("1) Show detailed module list");
      console.log("2) Validate expected counts");
      console.log("3) Re-scan current term (strict)");
      console.log("4) Re-scan current term (relaxed)");
      console.log("5) Generate strict-vs-relaxed audit JSON");
      console.log("6) Continue to translation/export");
      console.log("7) Abort");

      const choice = (await rl.question("Choose option [1-7]: ")).trim();
      if (choice === "1") {
        printDetailedModules(scraped);
      } else if (choice === "2") {
        await validateExpectedCounts(scraped, rl);
      } else if (choice === "3") {
        console.log("Re-scanning in strict mode...");
        scraped = await scrapeModulesForCourses(context, courses, {
          scanMode: "strict",
          curriculumUrl: config.curriculumUrl,
          curriculumCode: config.curriculumCode
        });
        scanMode = "strict";
      } else if (choice === "4") {
        console.log("Re-scanning in relaxed mode...");
        scraped = await scrapeModulesForCourses(context, courses, {
          scanMode: "relaxed",
          curriculumUrl: config.curriculumUrl,
          curriculumCode: config.curriculumCode
        });
        scanMode = "relaxed";
      } else if (choice === "5") {
        console.log("Building strict-vs-relaxed audit. This runs both scans for comparison...");
        const strictData = await scrapeModulesForCourses(context, courses, {
          scanMode: "strict",
          curriculumUrl: config.curriculumUrl,
          curriculumCode: config.curriculumCode
        });
        const relaxedData = await scrapeModulesForCourses(context, courses, {
          scanMode: "relaxed",
          curriculumUrl: config.curriculumUrl,
          curriculumCode: config.curriculumCode
        });
        const audit = buildStrictRelaxedAudit(strictData, relaxedData);
        const auditPath = writeAuditFile(config.outputDir, audit);
        console.log(`Audit written: ${auditPath}`);
      } else if (choice === "6") {
        done = true;
      } else if (choice === "7") {
        throw new Error("Aborted by user from CLI menu.");
      } else {
        console.log("Invalid choice. Please choose 1 to 7.");
      }
    }
  } finally {
    rl.close();
  }

  return { scraped, scanMode };
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
      console.error("[auth] See docs/cookie-refresh.md, then re-run.");
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
        console.error("[auth] Refresh cookies.json — see docs/cookie-refresh.md.");
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (args.observe) {
    console.warn("--observe is only available with --use-browser. Falling back to Playwright observe mode.");
    return runBrowser(args);
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

  printScrapeSummary(scraped, "strict");

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

  console.log("Done.");
  console.log(`Manifest: ${manifestPath}`);
}

async function runBrowser(args) {
  const context = await browserAdapter.launchContext(config);
  const page = await context.newPage();

  try {
    await browserAdapter.waitForLogin(page);

    if (args.loginOnly) {
      console.log("Login session initialized. You may now run: npm start");
      return;
    }

    if (args.observe) {
      await observerMode(context, config.outputDir);
      return;
    }

    await page.goto(config.curriculumUrl, { waitUntil: "domcontentloaded" });

    const nodes = await browserAdapter.extractCourseNodes(page);
    if (!nodes.length) {
      throw new Error("No course nodes found on curriculum page. Verify login and page structure.");
    }

    const columns = browserAdapter.clusterByColumn(nodes);
    const currentTerm = config.studentMode === "regular"
      ? browserAdapter.pickCurrentTermForRegular(columns)
      : browserAdapter.pickCurrentTermForIrregular(columns);

    if (!currentTerm) {
      throw new Error(
        `Could not determine current term for mode: ${config.studentMode}. ` +
        "You can switch STUDENT_MODE or update term detection in src/paraverse.js."
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

    let scraped = await browserAdapter.scrapeModulesForCourses(context, selectedCourses, {
      scanMode: "strict",
      curriculumUrl: config.curriculumUrl,
      curriculumCode: config.curriculumCode
    });

    const reviewed = await reviewScrapeMenu(context, selectedCourses, scraped);
    scraped = reviewed.scraped;

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

    const manifestPath = await browserAdapter.exportTranslatedHtml(config.outputDir, scraped, createTranslator, {
      requestContext: context.request
    });

    console.log("Done.");
    console.log(`Manifest: ${manifestPath}`);
  } finally {
    await page.close();
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.useBrowser) {
    await runBrowser(args);
  } else {
    await runHeadless(args);
  }
}

main().catch((err) => {
  if (err && err.code === "SESSION_EXPIRED") {
    console.error(`\n[auth] ${err.message}`);
    console.error("[auth] Refresh cookies.json — see docs/cookie-refresh.md.");
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
