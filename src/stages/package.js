/**
 * Stage: package
 *
 * Responsibilities:
 *   - Write/refresh output/manifest.json with the final per-module records
 *   - Print a verification summary (PDFs detected vs PDFs/JSONs on disk)
 *
 * Reads from context:  extractedModules (preferred) or downloadedModules,
 *                      translatedModules (optional), config.outputDir
 * Writes to context:   manifestPath
 *
 * Always runs (manifest is cheap and always wanted).
 */

const fs = require("fs");
const path = require("path");

function relativeFromCourse(courseFolder, full) {
  if (!full) return "";
  return path.relative(courseFolder, full).split(path.sep).join("/");
}

function pickModulesForManifest(context) {
  if (context.renderedModules && context.renderedModules.length) return context.renderedModules;
  if (context.translatedModules && context.translatedModules.length) return context.translatedModules;
  if (context.extractedModules && context.extractedModules.length) return context.extractedModules;
  if (context.downloadedModules && context.downloadedModules.length) return context.downloadedModules;
  return [];
}

function buildManifest(context) {
  const entries = pickModulesForManifest(context);
  return entries.map((entry) => ({
    course: {
      title: entry.course.title,
      courseCode: entry.course.courseCode || "",
      href: entry.course.href || ""
    },
    moduleFiles: entry.modules.map((m) => {
      const record = {
        title: m.title,
        status: m.status || "unknown"
      };
      if (m.cachedPath) record.pdf = relativeFromCourse(entry.courseFolder, m.cachedPath);
      if (m.jsonPath) record.json = relativeFromCourse(entry.courseFolder, m.jsonPath);
      if (m.translatedPath) record.translated = relativeFromCourse(entry.courseFolder, m.translatedPath);
      if (m.pptxPath) record.pptx = relativeFromCourse(entry.courseFolder, m.pptxPath);
      if (m.pdfTranslatedPath) record.pdfTranslated = relativeFromCourse(entry.courseFolder, m.pdfTranslatedPath);
      if (m.renderStatus) record.renderStatus = m.renderStatus;
      if (typeof m.pageCount === "number") record.pageCount = m.pageCount;
      if (typeof m.pageCountAfterClean === "number") record.pageCountAfterClean = m.pageCountAfterClean;
      if (typeof m.lineCount === "number") record.lineCount = m.lineCount;
      if (typeof m.bytes === "number") record.bytes = m.bytes;
      if (m.translateStatus) record.translateStatus = m.translateStatus;
      if (m.translateReason) record.translateReason = m.translateReason;
      if (m.error) record.error = m.error;
      return record;
    })
  }));
}

function verify(context, log) {
  const entries = pickModulesForManifest(context);
  log("\n=== Verification ===");
  let allOk = true;
  let totalModules = 0;
  let totalPdfs = 0;
  let totalJsons = 0;
  let totalTranslated = 0;
  for (const entry of entries) {
    const m = entry.modules.length;
    const pdfs = entry.modules.filter((x) => x.cachedPath && fs.existsSync(x.cachedPath)).length;
    const jsons = entry.modules.filter((x) => x.jsonPath && fs.existsSync(x.jsonPath)).length;
    const translated = entry.modules.filter((x) => x.translatedPath && fs.existsSync(x.translatedPath)).length;
    totalModules += m;
    totalPdfs += pdfs;
    totalJsons += jsons;
    totalTranslated += translated;
    const ok = pdfs >= m && jsons >= pdfs;
    if (!ok) allOk = false;
    const mark = ok ? "OK  " : "WARN";
    log(`  [${mark}] ${entry.course.title}: ${m}modules / ${pdfs}pdfs / ${jsons}jsons / ${translated}translated`);
  }
  log(`Totals: ${totalModules}modules / ${totalPdfs}pdfs / ${totalJsons}jsons / ${totalTranslated}translated`);
  if (!allOk) log("WARNING: Some courses have fewer artifacts than detected modules. See logs above.");
  return allOk;
}

async function run(context, deps) {
  const log = (deps && deps.log) || (() => {});
  const manifest = buildManifest(context);
  const manifestPath = path.join(context.config.outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  log(`[package] Manifest written: ${manifestPath}`);
  verify(context, log);
  return { ...context, manifestPath };
}

module.exports = { name: "package", run, buildManifest, verify };
