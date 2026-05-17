const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { createHttpClient, SessionExpiredError } = require("./httpClient");
const {
  extractCurriculumCourses,
  clusterByColumn,
  pickCurrentTermForRegular,
  extractCourseModules,
  extractModuleAssetUrls,
  pickPresentationUrl
} = require("./htmlExtract");
const { ensureDir, safeFileName } = require("./utils");
const { cacheAsset, detectAssetType, extractSourceAssetUrl } = require("./pdfPptTranslate");
const { writePdfJson } = require("./pdfToJson");

const PARAVERSE_ORIGIN = "https://paraverse.feutech.edu.ph";

function buildCourseMapUrl(curriculumUrl, courseCode, curriculumCode) {
  if (!courseCode) return "";
  let origin = PARAVERSE_ORIGIN;
  try {
    origin = new URL(curriculumUrl).origin;
  } catch {
    // keep default
  }
  return `${origin}/network-map/course/${encodeURIComponent(courseCode)}&curriculum=${encodeURIComponent(curriculumCode || "")}`;
}

function buildModuleFetchUrl(courseId, moduleId, courseStatus) {
  const status = (courseStatus || "active").toLowerCase();
  return `${PARAVERSE_ORIGIN}/network-map/includes/core-fetch-modules.php?course-id=${encodeURIComponent(courseId)}&module-id=${encodeURIComponent(moduleId)}&course-status=${encodeURIComponent(status)}`;
}

function pickCurrentTermForIrregular() {
  return null;
}

function buildModuleStubHtml(courseTitle, moduleTitle, moduleHref) {
  const safeTitle = moduleTitle || "Module";
  const safeCourse = courseTitle || "Course";
  if (!moduleHref) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body><h1>${safeCourse}</h1><h2>${safeTitle}</h2><p>No direct module file URL was exposed by the page for this module.</p></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body><h1>${safeCourse}</h1><h2>${safeTitle}</h2><p>Source file:</p><p><a href="${moduleHref}">${moduleHref}</a></p></body></html>`;
}

async function loadCurriculumCourses(http, curriculumUrl) {
  const html = await http.fetchHtml(curriculumUrl);
  return extractCurriculumCourses(html);
}

async function scrapeModulesForCourses(http, courses, options = {}) {
  const scanMode = options.scanMode || "strict";
  const curriculumUrl = options.curriculumUrl || `${PARAVERSE_ORIGIN}/network-map/curriculum/`;
  const curriculumCode = options.curriculumCode || "";
  const results = [];

  for (const course of courses) {
    const courseCode = (course.courseCode || "").toUpperCase();
    const courseUrl = course.href || buildCourseMapUrl(curriculumUrl, courseCode, curriculumCode);
    console.log(`Scanning course map: ${courseCode || course.title}`);

    let courseHtml = "";
    try {
      courseHtml = await http.fetchHtml(courseUrl);
    } catch (err) {
      console.warn(`  Failed to fetch course map (${courseCode}): ${err.message}`);
      results.push({
        course: { ...course, courseCode, href: courseUrl },
        scanMode,
        courseHtml: "",
        moduleLinks: [{ href: courseUrl, title: `${course.title} Course Page` }],
        modulePages: [{
          href: courseUrl,
          title: `${course.title} Course Page`,
          html: buildModuleStubHtml(course.title, `${course.title} Course Page`, courseUrl)
        }]
      });
      continue;
    }

    const moduleLinks = extractCourseModules(courseHtml, { currentCourseCode: courseCode, scanMode });

    for (const module of moduleLinks) {
      try {
        const fetchUrl = buildModuleFetchUrl(module.courseId, module.moduleId, "active");
        // This endpoint is loaded by jQuery's $.load() in the browser, so the
        // server requires the AJAX-shaped header set (X-Requested-With, cors
        // Sec-Fetch-*, Referer pointing at the course page). Without these
        // it returns 403 Forbidden even with valid cookies.
        const moduleHtml = await http.fetchHtml(fetchUrl, { ajax: true, referer: courseUrl });
        const assetUrls = extractModuleAssetUrls(moduleHtml).map((u) => {
          try {
            return new URL(u, PARAVERSE_ORIGIN).href;
          } catch {
            return u;
          }
        });
        const pdfUrl = pickPresentationUrl(assetUrls);
        if (pdfUrl) {
          module.href = pdfUrl;
        }
      } catch (err) {
        if (err instanceof SessionExpiredError) {
          throw err;
        }
        console.warn(`  Module fetch failed for ${courseCode}/${module.moduleId}: ${err.message}`);
      }

      if (!module.href) {
        module.href = `${courseUrl}#module-${module.moduleId}`;
      }
    }

    const modulePages = (moduleLinks.length
      ? moduleLinks
      : [{ href: courseUrl, title: `${course.title} Course Page` }]
    ).map((module) => ({
      href: module.href,
      title: module.title,
      html: buildModuleStubHtml(course.title, module.title, module.href)
    }));

    results.push({
      course: { ...course, courseCode, href: courseUrl },
      scanMode,
      courseHtml,
      moduleLinks: moduleLinks.length ? moduleLinks : [{ href: courseUrl, title: `${course.title} Course Page` }],
      modulePages
    });
  }

  return results;
}

// Files/dirs that may legitimately live at the course folder root. Anything
// else (legacy .html stubs, old .json page-objects, .translated.pptx, etc.)
// gets pruned before each export so old runs don't leave junk behind.
const KEEP_AT_COURSE_ROOT = new Set(["pdf", "json"]);

function cleanCourseFolder(courseFolder) {
  if (!fs.existsSync(courseFolder)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(courseFolder)) {
    if (KEEP_AT_COURSE_ROOT.has(name)) continue;
    const full = path.join(courseFolder, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

async function exportTranslatedHtml(outputDir, scrapedData, createTranslator, runtimeOptions = {}) {
  ensureDir(outputDir);
  const requestContext = runtimeOptions.requestContext;
  const manifest = [];

  for (const entry of scrapedData) {
    const courseFolder = path.join(outputDir, safeFileName(entry.course.title || entry.course.href));
    ensureDir(courseFolder);

    const pruned = cleanCourseFolder(courseFolder);
    if (pruned > 0) {
      console.log(`[export] === ${entry.course.title} (cleaned ${pruned} legacy file(s)) ===`);
    } else {
      console.log(`[export] === ${entry.course.title} ===`);
    }

    const coursePdfFolder = path.join(courseFolder, "pdf");
    const courseJsonFolder = path.join(courseFolder, "json");
    ensureDir(coursePdfFolder);
    ensureDir(courseJsonFolder);

    const moduleFiles = [];
    for (let i = 0; i < entry.modulePages.length; i += 1) {
      const module = entry.modulePages[i];
      const fileBase = `${String(i + 1).padStart(2, "0")}-${safeFileName(module.title)}`;
      console.log(`[export]   module ${i + 1}/${entry.modulePages.length}: ${module.title.slice(0, 60)}`);

      // Resolve to the raw asset URL (handles viewer.html?file= wrappers too).
      const assetUrl = extractSourceAssetUrl(module.href) || module.href;
      const ext = detectAssetType(assetUrl);
      if (!assetUrl || ext === "unknown") {
        moduleFiles.push({
          title: module.title,
          sourceAssetUrl: module.href || "",
          status: "no-asset-url"
        });
        continue;
      }

      const cachedPath = path.join(coursePdfFolder, `${fileBase}.source.${ext}`);
      let cacheResult;
      try {
        cacheResult = await cacheAsset(requestContext, assetUrl, cachedPath);
      } catch (err) {
        console.warn(`[export]     download failed: ${err.message}`);
        moduleFiles.push({
          title: module.title,
          sourceAssetUrl: assetUrl,
          status: "download-failed",
          error: err.message
        });
        continue;
      }

      const entryRecord = {
        title: module.title,
        sourceAssetUrl: assetUrl,
        pdf: path.relative(courseFolder, cacheResult.filePath).split(path.sep).join("/"),
        cacheHit: Boolean(cacheResult.cacheHit)
      };

      // Only PDFs convert to the compact per-page JSON.
      if (ext === "pdf") {
        try {
          const jsonOut = path.join(courseJsonFolder, `${fileBase}.json`);
          const result = await writePdfJson(cachedPath, jsonOut, {
            course: entry.course.title,
            module: module.title
          }, { compact: true });
          entryRecord.json = path.relative(courseFolder, jsonOut).split(path.sep).join("/");
          entryRecord.pageCount = result.pageCount;
          entryRecord.pageCountAfterClean = result.pageCountAfterClean;
          entryRecord.lineCount = result.lineCount;
          entryRecord.bytes = result.bytes;
          entryRecord.status = "ok";
        } catch (err) {
          entryRecord.status = "json-failed";
          entryRecord.error = err.message;
        }
      } else {
        entryRecord.status = `cached-${ext}-no-json`;
      }

      moduleFiles.push(entryRecord);
    }

    manifest.push({
      course: entry.course,
      moduleFiles
    });
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}

module.exports = {
  PARAVERSE_ORIGIN,
  buildCourseMapUrl,
  buildModuleFetchUrl,
  loadCurriculumCourses,
  clusterByColumn,
  pickCurrentTermForRegular,
  pickCurrentTermForIrregular,
  scrapeModulesForCourses,
  exportTranslatedHtml,
  createHttpClient,
  cleanCourseFolder
};
