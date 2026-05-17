/**
 * Stage: scrape
 *
 * Responsibilities:
 *   - For each selected course, fetch the course-map HTML
 *   - Extract the module list via cheerio
 *   - For each module, hit /network-map/includes/core-fetch-modules.php
 *     (AJAX endpoint, requires X-Requested-With + Referer) to resolve the
 *     real PDF asset URL
 *
 * Reads from context:  http, selectedCourses, config
 * Writes to context:   scrapedModules[] = [{ course, modules[] }]
 *
 * Skipped when:  scrapedModules already populated (--use-saved path)
 */

const { URL } = require("url");
const { SessionExpiredError } = require("../httpClient");
const {
  extractCourseModules,
  extractModuleAssetUrls,
  pickPresentationUrl
} = require("../htmlExtract");

const PARAVERSE_ORIGIN = "https://paraverse.feutech.edu.ph";

function buildCourseMapUrl(curriculumUrl, courseCode, curriculumCode) {
  if (!courseCode) return "";
  let origin = PARAVERSE_ORIGIN;
  try {
    origin = new URL(curriculumUrl).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/network-map/course/${encodeURIComponent(courseCode)}&curriculum=${encodeURIComponent(curriculumCode || "")}`;
}

function buildModuleFetchUrl(courseId, moduleId, courseStatus) {
  const status = (courseStatus || "active").toLowerCase();
  return `${PARAVERSE_ORIGIN}/network-map/includes/core-fetch-modules.php?course-id=${encodeURIComponent(courseId)}&module-id=${encodeURIComponent(moduleId)}&course-status=${encodeURIComponent(status)}`;
}

async function scrapeCourse(http, course, options, log) {
  const courseCode = (course.courseCode || "").toUpperCase();
  const courseUrl =
    course.href || buildCourseMapUrl(options.curriculumUrl, courseCode, options.curriculumCode);
  log(`[scrape] ${courseCode || course.title}`);

  let courseHtml = "";
  try {
    courseHtml = await http.fetchHtml(courseUrl);
  } catch (err) {
    log(`[scrape]   course-map fetch failed: ${err.message}`);
    return {
      course: { ...course, courseCode, href: courseUrl },
      modules: []
    };
  }

  const moduleLinks = extractCourseModules(courseHtml, {
    currentCourseCode: courseCode,
    scanMode: options.scanMode || "strict"
  });

  const modules = [];
  for (const m of moduleLinks) {
    let assetUrl = "";
    try {
      const fetchUrl = buildModuleFetchUrl(m.courseId, m.moduleId, "active");
      const moduleHtml = await http.fetchHtml(fetchUrl, { ajax: true, referer: courseUrl });
      const urls = extractModuleAssetUrls(moduleHtml).map((u) => {
        try { return new URL(u, PARAVERSE_ORIGIN).href; } catch { return u; }
      });
      assetUrl = pickPresentationUrl(urls);
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      log(`[scrape]   module ${m.moduleId} fetch failed: ${err.message}`);
    }
    modules.push({
      ...m,
      assetUrl: assetUrl || ""
    });
  }

  return {
    course: { ...course, courseCode, href: courseUrl },
    modules
  };
}

async function run(context, deps) {
  const { http, selectedCourses, config } = context;
  const log = (deps && deps.log) || (() => {});
  const scrapedModules = [];
  for (const course of selectedCourses) {
    const result = await scrapeCourse(http, course, {
      curriculumUrl: config.curriculumUrl,
      curriculumCode: config.curriculumCode
    }, log);
    scrapedModules.push(result);
  }
  return { ...context, scrapedModules };
}

function canSkip(context) {
  return Boolean(context && context.scrapedModules && context.scrapedModules.length);
}

module.exports = { name: "scrape", run, canSkip, buildCourseMapUrl, buildModuleFetchUrl };
