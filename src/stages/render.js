/**
 * Stage: render
 *
 * Responsibilities:
 *   - Take each translated JSON, generate a Taglish PowerPoint deck via
 *     pptxgenjs → output/<course>/pptx/<base>.tl.pptx
 *   - Convert each PPTX to PDF via pptxToPdf (PowerPoint COM on Windows,
 *     LibreOffice headless elsewhere) → output/<course>/pdf/<base>.tl.pdf
 *
 * Reads from context:  translatedModules, cliArgs.targetLang
 * Writes to context:   renderedModules[] = [{ course, modules[] with pptxPath, pdfTranslatedPath, status }]
 *
 * Skipped when:  cliArgs.render is false. Render is opt-in via --render.
 *                Also skipped if there are no translated files to render.
 */

const fs = require("fs");
const path = require("path");
const PptxGenJS = require("pptxgenjs");
const { ensureDir } = require("../utils");
const { convert: pptxToPdf } = require("../pptxToPdf");

const SLIDE_W = 13.333; // inches, 16:9 widescreen
const SLIDE_H = 7.5;
const MARGIN_X = 0.5;
const MARGIN_Y = 0.4;
const HEADING_FS = 22;
const PARAGRAPH_FS = 14;

function buildSlideTextRuns(linesArr) {
  // Build a structured text array for pptxgenjs: each line becomes a
  // paragraph with formatting based on whether it's a heading (h) or
  // paragraph (p).
  const runs = [];
  for (const line of linesArr) {
    if (line.h !== undefined) {
      runs.push({
        text: String(line.h),
        options: { bold: true, fontSize: HEADING_FS, color: "1F4E79", breakLine: true }
      });
    } else if (line.p !== undefined) {
      runs.push({
        text: String(line.p),
        options: { fontSize: PARAGRAPH_FS, color: "333333", breakLine: true }
      });
    }
  }
  // If a page is somehow empty, add a placeholder so the slide isn't blank.
  if (runs.length === 0) {
    runs.push({ text: " ", options: { fontSize: PARAGRAPH_FS } });
  }
  return runs;
}

async function renderTranslatedPptx(translatedJson, outputPath, courseTitle, moduleTitle) {
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 inches
  pres.title = `${courseTitle} — ${moduleTitle} (Taglish)`;

  for (const page of translatedJson.pages) {
    const slide = pres.addSlide();
    slide.background = { color: "FFFFFF" };
    slide.addText(`Page ${page.n}`, {
      x: SLIDE_W - 1.3, y: 0.15, w: 1.1, h: 0.3,
      fontSize: 10, color: "999999", align: "right"
    });
    slide.addText(buildSlideTextRuns(page.lines), {
      x: MARGIN_X,
      y: MARGIN_Y,
      w: SLIDE_W - MARGIN_X * 2,
      h: SLIDE_H - MARGIN_Y * 2,
      valign: "top",
      fit: "shrink"
    });
  }

  ensureDir(path.dirname(outputPath));
  await pres.writeFile({ fileName: outputPath });
  return outputPath;
}

async function run(context, deps) {
  const log = (deps && deps.log) || (() => {});
  const targetLang = (context.cliArgs && context.cliArgs.targetLang) || "tl";

  if (!context.translatedModules || !context.translatedModules.length) {
    log("[render] No translated modules in context; skipping.");
    return { ...context, renderedModules: [] };
  }

  const renderedModules = [];
  const pdfJobs = []; // collect all .pptx → .pdf conversion jobs to batch at the end

  for (const entry of context.translatedModules) {
    log(`[render] === ${entry.course.title} ===`);
    const pptxFolder = path.join(entry.courseFolder, "pptx");
    const pdfFolder = path.join(entry.courseFolder, "pdf");
    ensureDir(pptxFolder);
    ensureDir(pdfFolder);

    const out = [];
    for (let i = 0; i < entry.modules.length; i += 1) {
      const m = entry.modules[i];
      if (!m.translatedPath || !fs.existsSync(m.translatedPath)) {
        out.push({ ...m, renderStatus: "no-translation" });
        continue;
      }

      const pptxOut = path.join(pptxFolder, `${m.fileBase || path.basename(m.translatedPath, ".tl.json")}.${targetLang}.pptx`);
      const pdfOut = path.join(pdfFolder, `${m.fileBase || path.basename(m.translatedPath, ".tl.json")}.${targetLang}.pdf`);

      try {
        const translatedJson = JSON.parse(fs.readFileSync(m.translatedPath, "utf8"));
        await renderTranslatedPptx(translatedJson, pptxOut, entry.course.title, m.title || m.fileBase);
        log(`[render]   ${i + 1}/${entry.modules.length} pptx ${path.basename(pptxOut)}`);
        pdfJobs.push({ input: pptxOut, output: pdfOut });
        out.push({
          ...m,
          pptxPath: pptxOut,
          pdfTranslatedPath: pdfOut,
          renderStatus: "pptx-ready"
        });
      } catch (err) {
        log(`[render]   ${i + 1}/${entry.modules.length} FAILED: ${err.message}`);
        out.push({ ...m, renderStatus: "pptx-failed", renderError: err.message });
      }
    }

    renderedModules.push({
      course: entry.course,
      courseFolder: entry.courseFolder,
      modules: out
    });
  }

  // Batch PPTX → PDF conversion. PowerPoint COM is slow to start, so doing
  // all conversions in one PowerPoint session is much faster than per-file.
  if (pdfJobs.length) {
    log(`[render] Converting ${pdfJobs.length} pptx(s) to pdf via PowerPoint COM (or LibreOffice)...`);
    const result = await pptxToPdf(pdfJobs, { log });
    log(`[render] Conversion: ${result.ok} ok, ${result.failed} failed.`);
    if (result.errors.length) {
      for (const e of result.errors.slice(0, 5)) log(`[render]   ${e}`);
    }
    // Stamp final status per module based on whether the PDF actually appeared.
    for (const entry of renderedModules) {
      for (const m of entry.modules) {
        if (m.pdfTranslatedPath && fs.existsSync(m.pdfTranslatedPath)) {
          m.renderStatus = "pdf-ready";
        } else if (m.renderStatus === "pptx-ready") {
          m.renderStatus = "pdf-conversion-failed";
        }
      }
    }
  }

  return { ...context, renderedModules };
}

function canSkip(context) {
  if (!context || !context.cliArgs || !context.cliArgs.render) return true;
  if (!context.translatedModules || !context.translatedModules.length) return true;
  return false;
}

module.exports = { name: "render", run, canSkip, renderTranslatedPptx };
