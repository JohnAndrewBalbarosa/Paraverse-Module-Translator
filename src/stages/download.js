/**
 * Stage: download
 *
 * Responsibilities:
 *   - Ensure each course folder exists at output/<course>/
 *   - Prune legacy junk files from the course root (keep only pdf/ + json/)
 *   - For each module with an assetUrl, cache the asset to
 *     output/<course>/pdf/<base>.source.<ext> via cacheAsset
 *
 * Reads from context:  scrapedModules, http, config.outputDir
 * Writes to context:   downloadedModules[] = [{ course, modules[] with cachedPath }]
 *
 * Skipped when:  downloadedModules already populated (--use-saved path builds
 *                this from disk)
 */

const fs = require("fs");
const path = require("path");
const { ensureDir, safeFileName } = require("../utils");
const { cacheAsset, detectAssetType, extractSourceAssetUrl } = require("../pdfPptTranslate");

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
      /* ignore */
    }
  }
  return removed;
}

function moduleFileBase(index, title) {
  return `${String(index + 1).padStart(2, "0")}-${safeFileName(title)}`;
}

async function run(context, deps) {
  const { scrapedModules, http, config } = context;
  const log = (deps && deps.log) || (() => {});
  const requestContext = http.asRequestContextShim();
  ensureDir(config.outputDir);
  const downloadedModules = [];

  for (const entry of scrapedModules) {
    const courseFolder = path.join(
      config.outputDir,
      safeFileName(entry.course.title || entry.course.href)
    );
    ensureDir(courseFolder);
    const pruned = cleanCourseFolder(courseFolder);
    if (pruned > 0) log(`[download] === ${entry.course.title} (cleaned ${pruned} legacy file(s)) ===`);
    else log(`[download] === ${entry.course.title} ===`);

    const pdfFolder = path.join(courseFolder, "pdf");
    const jsonFolder = path.join(courseFolder, "json");
    ensureDir(pdfFolder);
    ensureDir(jsonFolder);

    const downloaded = [];
    for (let i = 0; i < entry.modules.length; i += 1) {
      const m = entry.modules[i];
      const fileBase = moduleFileBase(i, m.title);
      const assetUrl = extractSourceAssetUrl(m.assetUrl) || m.assetUrl;
      const ext = detectAssetType(assetUrl);
      if (!assetUrl || ext === "unknown") {
        downloaded.push({ ...m, fileBase, cachedPath: "", status: "no-asset-url" });
        continue;
      }
      const cachedPath = path.join(pdfFolder, `${fileBase}.source.${ext}`);
      try {
        const result = await cacheAsset(requestContext, assetUrl, cachedPath);
        log(`[download]   ${i + 1}/${entry.modules.length} ${result.cacheHit ? "(cached)" : "(fetched)"} ${path.basename(result.filePath)}`);
        downloaded.push({
          ...m,
          fileBase,
          ext,
          cachedPath: result.filePath,
          cacheHit: result.cacheHit,
          status: "ok"
        });
      } catch (err) {
        log(`[download]   ${i + 1}/${entry.modules.length} FAILED: ${err.message}`);
        downloaded.push({
          ...m,
          fileBase,
          cachedPath: "",
          status: "download-failed",
          error: err.message
        });
      }
    }

    downloadedModules.push({
      course: entry.course,
      courseFolder,
      modules: downloaded
    });
  }

  return { ...context, downloadedModules };
}

function canSkip(context) {
  return Boolean(context && context.downloadedModules && context.downloadedModules.length);
}

module.exports = { name: "download", run, canSkip, cleanCourseFolder, moduleFileBase };
