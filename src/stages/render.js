/**
 * Stage: render
 *
 * Responsibilities:
 *   - For each translated module, produce a Taglish PDF that LOOKS identical
 *     to the source PDF (same images, charts, layout) — only the text is
 *     replaced. Done by `src/pdfOverlay.js` which loads the source PDF and
 *     white-boxes + redraws each text line.
 *   - Output goes to `output/<course>/pdf/<base>.tl.pdf`, next to the source.
 *
 * Reads from context:  translatedModules
 * Writes to context:   renderedModules[] = [{ course, modules[] with pdfTranslatedPath, status }]
 *
 * Skipped when:  cliArgs.render is false OR no translated modules.
 */

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("../utils");
const { overlayTranslation } = require("../pdfOverlay");

async function run(context, deps) {
  const log = (deps && deps.log) || (() => {});

  if (!context.translatedModules || !context.translatedModules.length) {
    log("[render] No translated modules in context; skipping.");
    return { ...context, renderedModules: [] };
  }

  const renderedModules = [];

  for (const entry of context.translatedModules) {
    log(`[render] === ${entry.course.title} ===`);
    const pdfFolder = path.join(entry.courseFolder, "pdf");
    ensureDir(pdfFolder);

    const out = [];
    for (let i = 0; i < entry.modules.length; i += 1) {
      const m = entry.modules[i];
      if (!m.translatedPath || !fs.existsSync(m.translatedPath)) {
        out.push({ ...m, renderStatus: "no-translation" });
        continue;
      }
      if (!m.cachedPath || !fs.existsSync(m.cachedPath)) {
        out.push({ ...m, renderStatus: "no-source-pdf" });
        continue;
      }

      const base = m.fileBase || path.basename(m.translatedPath, ".tl.json");
      const pdfOut = path.join(pdfFolder, `${base}.tl.pdf`);

      try {
        const translatedJson = JSON.parse(fs.readFileSync(m.translatedPath, "utf8"));
        const result = await overlayTranslation(m.cachedPath, translatedJson, pdfOut, { log });
        log(`[render]   ${i + 1}/${entry.modules.length} ${path.basename(pdfOut)} (${result.overlays} overlays, ${result.skipped} skipped)`);
        out.push({
          ...m,
          pdfTranslatedPath: pdfOut,
          renderStatus: "pdf-ready",
          overlays: result.overlays,
          overlaySkipped: result.skipped
        });
      } catch (err) {
        log(`[render]   ${i + 1}/${entry.modules.length} FAILED ${base}: ${err.message}`);
        out.push({
          ...m,
          renderStatus: "overlay-failed",
          renderError: err.message
        });
      }
    }

    renderedModules.push({
      course: entry.course,
      courseFolder: entry.courseFolder,
      modules: out
    });
  }

  return { ...context, renderedModules };
}

function canSkip(context) {
  if (!context || !context.cliArgs || !context.cliArgs.render) return true;
  if (!context.translatedModules || !context.translatedModules.length) return true;
  return false;
}

module.exports = { name: "render", run, canSkip };
