/**
 * Stage: checker
 *
 * Sits between `translate` and `render`. Re-extracts each source PDF with the
 * container-aware pipeline and compares against the translated JSON, then
 * writes a per-module check report at
 *   output/<course>/checks/<base>.check.json
 *
 * The job is to give the user (and future Claude sessions) visibility into:
 *   - Per-page container counts (how visually busy is the slide?)
 *   - Cross-container splits that container awareness prevented (signal that
 *     the old pipeline would have produced wrong merges here)
 *   - Source-vs-translated line-count drift (signal that the LLM dropped or
 *     added lines, which causes index-pair misalignment in overlay)
 *   - Pages where drift is concentrated (so a human knows where to look)
 *
 * Does NOT block render. Render still uses its own re-extraction (this stage
 * is purely diagnostic + an audit trail).
 *
 * Reads from context:  translatedModules
 * Writes to context:   checkedModules[] = [{ course, modules[] with checkPath }]
 */

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("../utils");
const { extractPagesAsJson, cleanPages, toCompactForm } = require("../pdfToJson");

async function run(context, deps) {
  const log = (deps && deps.log) || (() => {});

  if (!context.translatedModules || !context.translatedModules.length) {
    log("[checker] No translated modules in context; skipping.");
    return { ...context, checkedModules: [] };
  }

  const checkedModules = [];

  for (const entry of context.translatedModules) {
    log(`[checker] === ${entry.course.title} ===`);
    const checksFolder = path.join(entry.courseFolder, "checks");
    ensureDir(checksFolder);

    const out = [];
    for (let i = 0; i < entry.modules.length; i += 1) {
      const m = entry.modules[i];
      if (!m.cachedPath || !fs.existsSync(m.cachedPath)) {
        out.push({ ...m, checkStatus: "no-source-pdf" });
        continue;
      }

      try {
        const buf = fs.readFileSync(m.cachedPath);
        const ext = await extractPagesAsJson(buf);
        const cleanedSrc = toCompactForm(cleanPages(ext.pages));

        const srcLineCount = cleanedSrc.reduce((s, p) => s + p.lines.length, 0);
        const containerLineCount = cleanedSrc.reduce(
          (s, p) => s + p.lines.filter((l) => l.c != null).length, 0
        );

        let trnLineCount = 0;
        let trnPageCount = 0;
        const perPageDrift = [];
        if (m.translatedPath && fs.existsSync(m.translatedPath)) {
          const trn = JSON.parse(fs.readFileSync(m.translatedPath, "utf8"));
          const trnPages = Array.isArray(trn.pages) ? trn.pages : [];
          trnPageCount = trnPages.length;
          for (const p of trnPages) {
            trnLineCount += Array.isArray(p.lines) ? p.lines.length : 0;
          }
          const cap = Math.min(cleanedSrc.length, trnPages.length);
          for (let k = 0; k < cap; k += 1) {
            const sl = cleanedSrc[k].lines.length;
            const tl = Array.isArray(trnPages[k].lines) ? trnPages[k].lines.length : 0;
            if (sl !== tl) {
              perPageDrift.push({ page: cleanedSrc[k].n, source: sl, translated: tl });
            }
          }
        }

        const containerStats = ext.containerStats || { perPage: [], totalContainers: 0, splitsPrevented: 0 };
        const avgContainersPerPage = containerStats.perPage.length
          ? +(containerStats.totalContainers / containerStats.perPage.length).toFixed(1)
          : 0;

        const checkData = {
          module: m.fileBase,
          source: path.basename(m.cachedPath),
          schemaUsed: "compact-v2",
          containerStats: {
            ...containerStats,
            avgContainersPerPage
          },
          lineCount: {
            source: srcLineCount,
            translated: trnLineCount,
            drift: srcLineCount - trnLineCount,
            inContainers: containerLineCount,
            inContainersPct: srcLineCount
              ? +((containerLineCount / srcLineCount) * 100).toFixed(1)
              : 0
          },
          pageCount: {
            source: cleanedSrc.length,
            translated: trnPageCount
          },
          pagesWithLineCountDrift: perPageDrift,
          generatedAt: new Date().toISOString()
        };

        const checkPath = path.join(checksFolder, `${m.fileBase}.check.json`);
        fs.writeFileSync(checkPath, JSON.stringify(checkData, null, 2), "utf8");

        log(
          `[checker]   ${i + 1}/${entry.modules.length} ${m.fileBase}: ` +
          `${avgContainersPerPage} containers/page, ` +
          `${containerStats.splitsPrevented} splits prevented, ` +
          `drift=${srcLineCount - trnLineCount} ` +
          `(${perPageDrift.length} pages off)`
        );
        out.push({ ...m, checkPath, checkStatus: "ok" });
      } catch (err) {
        log(`[checker]   ${i + 1}/${entry.modules.length} FAILED ${m.fileBase}: ${err.message}`);
        out.push({ ...m, checkStatus: "check-failed", checkError: err.message });
      }
    }

    checkedModules.push({
      course: entry.course,
      courseFolder: entry.courseFolder,
      modules: out
    });
  }

  return { ...context, checkedModules };
}

function canSkip(context) {
  if (!context || !context.translatedModules || !context.translatedModules.length) return true;
  return false;
}

module.exports = { name: "checker", run, canSkip };
