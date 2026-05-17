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
const { ensureDir, safeFileName, writeModuleJson } = require("./utils");
const { translateHtmlPreservingMarkup, buildPageObjectFromHtml } = require("./htmlTranslate");
const { translatePageObject } = require("./pageObjectTranslator");
const { generateTranslatedPptFromPdf } = require("./pdfPptTranslate");
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

async function exportTranslatedHtml(outputDir, scrapedData, createTranslator, runtimeOptions = {}) {
  ensureDir(outputDir);
  const requestContext = runtimeOptions.requestContext;
  const manifest = [];

  for (const entry of scrapedData) {
    const courseFolder = path.join(outputDir, safeFileName(entry.course.title || entry.course.href));
    ensureDir(courseFolder);
    const coursePdfFolder = path.join(courseFolder, "pdf");
    fs.rmSync(coursePdfFolder, { recursive: true, force: true });
    ensureDir(coursePdfFolder);

    console.log(`[export] === ${entry.course.title} (${entry.modulePages.length} module(s)) ===`);

    const courseTranslator = createTranslator();
    const translatedCourseHtml = await translateHtmlPreservingMarkup(entry.courseHtml, courseTranslator);
    const courseFile = path.join(courseFolder, "course.html");
    fs.writeFileSync(courseFile, translatedCourseHtml, "utf8");

    const moduleFiles = [];
    for (let i = 0; i < entry.modulePages.length; i += 1) {
      const module = entry.modulePages[i];
      if (!module.html) continue;
      console.log(`[export]   module ${i + 1}/${entry.modulePages.length}: ${module.title.slice(0, 60)}`);

      const moduleTranslator = createTranslator();
      const translatedModuleHtml = await translateHtmlPreservingMarkup(module.html, moduleTranslator);
      const fileBase = `${String(i + 1).padStart(2, "0")}-${safeFileName(module.title)}`;
      const fileName = `${fileBase}.html`;
      const moduleFile = path.join(courseFolder, fileName);
      fs.writeFileSync(moduleFile, translatedModuleHtml, "utf8");
      moduleFiles.push({ fileName, href: module.href, title: module.title, kind: "html" });

      try {
        const sourcePageObj = buildPageObjectFromHtml(module.html);
        const translatedPageObj = moduleTranslator.canTranslate()
          ? await translatePageObject(sourcePageObj, moduleTranslator)
          : sourcePageObj;
        const jsonFileName = `${fileBase}.json`;
        writeModuleJson(path.join(courseFolder, jsonFileName), {
          course: entry.course.title,
          module: module.title,
          sourceUrl: module.href,
          targetLanguage: moduleTranslator.targetLanguage,
          translatedAt: new Date().toISOString()
        }, sourcePageObj, translatedPageObj);
        moduleFiles.push({ fileName: jsonFileName, href: module.href, title: module.title, kind: "page-object-json" });
      } catch (err) {
        moduleFiles.push({ fileName: "", href: module.href, title: module.title, kind: "page-object-json-error", error: err.message });
      }

      try {
        const pptxName = `${fileBase}.translated.pptx`;
        const pptxPath = path.join(courseFolder, pptxName);
        const moduleKey = `${safeFileName(entry.course.courseCode || entry.course.title)}-${fileBase}`;
        const cacheFileBasePath = path.join(coursePdfFolder, `${fileBase}.source`);
        const pptxResult = await generateTranslatedPptFromPdf({
          requestContext,
          moduleHref: module.href,
          moduleTitle: module.title,
          moduleKey,
          cacheFileBasePath,
          outputPptxPath: pptxPath,
          translator: moduleTranslator,
          logger: (msg) => console.log(msg)
        });

        if (pptxResult.generated) {
          const cacheName = path.basename(pptxResult.cacheFilePath || "");
          if (cacheName) {
            moduleFiles.push({
              fileName: path.join("pdf", cacheName),
              href: module.href,
              title: module.title,
              kind: "cached-source-pdf",
              cacheHit: Boolean(pptxResult.cacheHit)
            });
          }
          moduleFiles.push({
            fileName: pptxName,
            href: module.href,
            title: module.title,
            kind: "translated-pptx",
            sourceAssetUrl: pptxResult.sourceAssetUrl,
            pageCount: pptxResult.pageCount
          });
        } else {
          if (pptxResult.cacheFilePath) {
            moduleFiles.push({
              fileName: path.join("pdf", path.basename(pptxResult.cacheFilePath)),
              href: module.href,
              title: module.title,
              kind: "cached-source-asset",
              cacheHit: Boolean(pptxResult.cacheHit),
              assetType: pptxResult.assetType || "unknown"
            });
          }
          moduleFiles.push({
            fileName: "",
            href: module.href,
            title: module.title,
            kind: "translated-pptx-skipped",
            reason: pptxResult.reason || "unknown"
          });
        }
      } catch (err) {
        moduleFiles.push({
          fileName: "",
          href: module.href,
          title: module.title,
          kind: "translated-pptx-error",
          error: err.message
        });
      }

      // Convert the cached source PDF into a compact per-page JSON for AI
      // translation. Lives in a sibling json/ folder (separate from pdf/) and
      // uses the compact schema by default to minimize prompt tokens.
      try {
        const cachedPdf = path.join(coursePdfFolder, `${fileBase}.source.pdf`);
        if (fs.existsSync(cachedPdf)) {
          const courseJsonFolder = path.join(courseFolder, "json");
          const jsonOut = path.join(courseJsonFolder, `${fileBase}.json`);
          const result = await writePdfJson(cachedPdf, jsonOut, {
            course: entry.course.title,
            module: module.title
          }, { compact: true });
          moduleFiles.push({
            fileName: path.join("json", path.basename(jsonOut)),
            href: module.href,
            title: module.title,
            kind: "source-pdf-pages-json",
            pageCount: result.pageCount,
            pageCountAfterClean: result.pageCountAfterClean,
            lineCount: result.lineCount,
            bytes: result.bytes
          });
        }
      } catch (err) {
        moduleFiles.push({
          fileName: "",
          href: module.href,
          title: module.title,
          kind: "source-pdf-pages-json-error",
          error: err.message
        });
      }
    }

    manifest.push({
      course: entry.course,
      courseFile: path.relative(outputDir, courseFile),
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
  createHttpClient
};
