/**
 * Stage: extract
 *
 * Responsibilities:
 *   - For each downloaded PDF, convert to compact per-page JSON via
 *     writePdfJson and save it at output/<course>/json/<base>.json
 *   - Skip non-PDF assets (they don't have a JSON conversion path yet)
 *
 * Reads from context:  downloadedModules
 * Writes to context:   extractedModules[] = [{ course, modules[] with jsonPath }]
 *
 * Never skipped automatically — extraction is the core deliverable.
 */

const path = require("path");
const { ensureDir } = require("../utils");
const { writePdfJson } = require("../pdfToJson");

async function run(context, deps) {
  const { downloadedModules } = context;
  const log = (deps && deps.log) || (() => {});
  const extractedModules = [];

  for (const entry of downloadedModules) {
    const jsonFolder = path.join(entry.courseFolder, "json");
    ensureDir(jsonFolder);
    log(`[extract] === ${entry.course.title} ===`);

    const out = [];
    for (let i = 0; i < entry.modules.length; i += 1) {
      const m = entry.modules[i];
      if (!m.cachedPath || m.ext !== "pdf") {
        out.push({ ...m, jsonPath: "", status: m.status || "no-pdf" });
        continue;
      }
      const jsonOut = path.join(jsonFolder, `${m.fileBase}.json`);
      try {
        const r = await writePdfJson(m.cachedPath, jsonOut, {
          course: entry.course.title,
          module: m.title
        }, { compact: true });
        const kb = (r.bytes / 1024).toFixed(1);
        log(`[extract]   ${i + 1}/${entry.modules.length} ${path.basename(jsonOut)}  ${r.pageCountAfterClean}p / ${r.lineCount}lines / ${kb}KB`);
        out.push({
          ...m,
          jsonPath: jsonOut,
          pageCount: r.pageCount,
          pageCountAfterClean: r.pageCountAfterClean,
          lineCount: r.lineCount,
          bytes: r.bytes,
          status: "ok"
        });
      } catch (err) {
        log(`[extract]   ${i + 1}/${entry.modules.length} FAILED ${m.fileBase}: ${err.message}`);
        out.push({
          ...m,
          jsonPath: "",
          status: "extract-failed",
          error: err.message
        });
      }
    }

    extractedModules.push({
      course: entry.course,
      courseFolder: entry.courseFolder,
      modules: out
    });
  }

  return { ...context, extractedModules };
}

module.exports = { name: "extract", run };
