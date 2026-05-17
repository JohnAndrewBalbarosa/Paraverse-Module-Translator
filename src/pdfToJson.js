const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * Convert a PDF into a per-page, line-by-line JSON structure suitable for
 * sending to an LLM for translation. The LLM is expected to replace each
 * element's `text` field with the translation and return the same shape.
 *
 * Output schema:
 * {
 *   meta: { sourceFile, course, module, generatedAt, pageCount },
 *   pages: [
 *     { page: 1, elements: [
 *       { type: "heading", text: "..." },
 *       { type: "paragraph", text: "..." }
 *     ] }
 *   ]
 * }
 */

const LINE_Y_TOLERANCE = 3; // PDF points — items within this Y delta are same line
const HEADING_FONT_MULTIPLIER = 1.25; // line fontSize > median*this => heading
const HEADING_MIN_MULTIPLIER = 1.05; // even mild emphasis if bold + slightly larger

function isBoldFont(fontName) {
  if (!fontName) return false;
  return /bold|black|heavy|semibold|extrabold/i.test(fontName);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function groupItemsIntoLines(items) {
  // Items have { str, transform: [a,b,c,d,x,y], width, height, fontName }
  // Y in PDF coords increases upward. Group by Y proximity.
  const buckets = [];
  for (const item of items) {
    if (!item || !item.str) continue;
    const text = item.str;
    if (!text.trim() && text !== " ") continue;
    const y = item.transform?.[5] ?? 0;
    const x = item.transform?.[4] ?? 0;
    const fontSize = Math.abs(item.transform?.[0] ?? item.height ?? 12);
    const fontName = item.fontName || "";
    const width = typeof item.width === "number" ? item.width : null;
    const existing = buckets.find((b) => Math.abs(b.y - y) <= LINE_Y_TOLERANCE);
    if (existing) {
      existing.items.push({ text, x, fontSize, fontName, width });
      existing.y = (existing.y + y) / 2; // running average
    } else {
      buckets.push({ y, items: [{ text, x, fontSize, fontName, width }] });
    }
  }
  // Sort buckets top-to-bottom (high Y → low Y in PDF coords)
  buckets.sort((a, b) => b.y - a.y);
  return buckets.map((b) => {
    b.items.sort((a, b2) => a.x - b2.x);
    return b;
  });
}

function joinItemsInLine(items) {
  // Join, inserting a space when X gap clearly separates words. Use actual
  // pdfjs width when available; only insert when gap exceeds half a space
  // character (~0.5 * fontSize for typical fonts).
  let out = "";
  let prev = null;
  for (const it of items) {
    if (prev) {
      const prevWidth = prev.width != null ? prev.width : prev.text.length * prev.fontSize * 0.5;
      const gap = it.x - (prev.x + prevWidth);
      const endsWithSpace = /\s$/.test(out);
      const startsWithSpace = /^\s/.test(it.text);
      // Require gap larger than ~half a typical space char to insert a space.
      // PDFs often emit adjacent glyphs (e.g., "M" + "orality") with tiny
      // positive gaps from kerning; we must NOT split those.
      if (!endsWithSpace && !startsWithSpace && gap > prev.fontSize * 0.45) {
        out += " ";
      }
    }
    out += it.text;
    prev = it;
  }
  return out.replace(/\s+/g, " ").trim();
}

function classifyLine(line, baselineFontSize) {
  const lineFontSize = Math.max(...line.items.map((i) => i.fontSize), 0);
  const hasBold = line.items.some((i) => isBoldFont(i.fontName));
  const text = joinItemsInLine(line.items);
  if (!text) return null;

  let type = "paragraph";
  if (baselineFontSize > 0) {
    if (lineFontSize >= baselineFontSize * HEADING_FONT_MULTIPLIER) {
      type = "heading";
    } else if (hasBold && lineFontSize >= baselineFontSize * HEADING_MIN_MULTIPLIER && text.length < 120) {
      type = "heading";
    } else if (hasBold && text.length < 80 && /^[A-Z0-9 \-:.,]+$/.test(text)) {
      // ALL-CAPS short bold lines often act as headings even without size diff
      type = "heading";
    }
  }
  return { type, text, fontSize: Math.round(lineFontSize * 10) / 10 };
}

async function extractPagesAsJson(pdfBuffer) {
  // pdfjs v3 wants a plain Uint8Array view. Node Buffer extends Uint8Array
  // but pdfjs rejects it by exact constructor check, so we always re-wrap.
  let data;
  if (Buffer.isBuffer(pdfBuffer)) {
    data = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
  } else if (pdfBuffer instanceof Uint8Array) {
    data = pdfBuffer;
  } else {
    data = new Uint8Array(pdfBuffer);
  }
  // verbosity 0 = ERRORS only. Suppresses noisy "fetchStandardFontData" warnings
  // that pdfjs prints when running in Node without bundled font assets — they
  // don't affect text extraction.
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    verbosity: 0
  });
  const doc = await loadingTask.promise;
  const pages = [];

  // First pass: collect all line font sizes across the document to compute
  // a stable baseline that won't be skewed by a single oversized cover page.
  const allLineSizes = [];
  const perPageRawLines = [];

  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const lines = groupItemsIntoLines(content.items);
    perPageRawLines.push(lines);
    for (const line of lines) {
      const fs = Math.max(...line.items.map((i) => i.fontSize), 0);
      if (fs > 0) allLineSizes.push(fs);
    }
  }

  const baseline = median(allLineSizes);

  for (let p = 1; p <= doc.numPages; p += 1) {
    const lines = perPageRawLines[p - 1];
    const elements = [];
    for (const line of lines) {
      const classified = classifyLine(line, baseline);
      if (classified && classified.text) {
        elements.push({ type: classified.type, text: classified.text });
      }
    }
    pages.push({ page: p, elements });
  }

  return { pageCount: doc.numPages, pages };
}

// ---------- Cleanup pass: token reduction for LLM prompts ----------

const SENTENCE_END = /[.!?…:](["'”’])?\s*$/;
const BULLET_OR_NUMBER_START = /^[\s]*([•·●▪■◆\-*]|\d+[.)\s]|[A-Z][.)\s]|\([a-z0-9]+\))/;
const PURE_NOISE = /^[\s\d\W]{0,3}$/; // 0-3 chars of digits/whitespace/punct only

function isNoiseLine(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (PURE_NOISE.test(trimmed)) return true; // page numbers, lone punctuation
  if (/^\d{1,3}$/.test(trimmed)) return true; // page numbers
  if (/^[•·●▪■◆\-*]+$/.test(trimmed)) return true; // lone bullet
  return false;
}

function reflowParagraphs(elements) {
  // Merge wrapped paragraph lines: if line A ends without a sentence-ending
  // mark and line B does not start with a new bullet/number/heading, B is a
  // continuation of A.
  const merged = [];
  for (const el of elements) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.type === "paragraph" &&
      el.type === "paragraph" &&
      !SENTENCE_END.test(prev.text) &&
      !BULLET_OR_NUMBER_START.test(el.text)
    ) {
      prev.text = `${prev.text} ${el.text.trim()}`.replace(/\s+/g, " ");
      continue;
    }
    merged.push({ ...el });
  }
  return merged;
}

function cleanPages(rawPages) {
  // Per-page: drop noise + reflow paragraphs. Skip pages that go empty.
  const cleaned = [];
  for (const p of rawPages) {
    const filtered = p.elements.filter((el) => !isNoiseLine(el.text));
    const reflowed = reflowParagraphs(filtered);
    if (reflowed.length) {
      cleaned.push({ page: p.page, elements: reflowed });
    }
  }
  return cleaned;
}

function toCompactForm(pages) {
  // Serialize each element as { h } for heading or { p } for paragraph.
  // Saves ~20-25 bytes per element vs the verbose { type, text } form.
  return pages.map((page) => ({
    n: page.page,
    lines: page.elements.map((el) =>
      el.type === "heading" ? { h: el.text } : { p: el.text }
    )
  }));
}

function countLines(pages) {
  return pages.reduce((s, p) => s + (p.elements ? p.elements.length : p.lines.length), 0);
}

// ---------- Public API ----------

async function convertPdfFileToJson(pdfPath, meta = {}, opts = {}) {
  const buf = fs.readFileSync(pdfPath);
  const { pageCount, pages } = await extractPagesAsJson(buf);

  const wantCleanCompact = opts.compact !== false; // default true
  const finalPages = wantCleanCompact ? cleanPages(pages) : pages;
  const serialized = wantCleanCompact ? toCompactForm(finalPages) : finalPages;

  return {
    meta: {
      source: path.basename(pdfPath),
      course: meta.course || "",
      module: meta.module || "",
      pageCount,
      pageCountAfterClean: wantCleanCompact ? serialized.length : pageCount,
      lineCount: wantCleanCompact
        ? serialized.reduce((s, p) => s + p.lines.length, 0)
        : countLines(finalPages),
      schema: wantCleanCompact ? "compact-v1" : "verbose-v1",
      schemaHint: wantCleanCompact
        ? "pages[].lines[] is an array of { h: heading-text } or { p: paragraph-text }. Translate by replacing the string values; keep keys and order identical."
        : "pages[].elements[] has { type, text }. Translate the text field.",
      generatedAt: new Date().toISOString()
    },
    pages: serialized
  };
}

async function writePdfJson(pdfPath, jsonOutPath, meta = {}, opts = {}) {
  const data = await convertPdfFileToJson(pdfPath, meta, opts);
  fs.mkdirSync(path.dirname(jsonOutPath), { recursive: true });
  // Use 1-space indent in compact mode for further token savings.
  const indent = opts.compact === false ? 2 : 1;
  fs.writeFileSync(jsonOutPath, JSON.stringify(data, null, indent), "utf8");
  return {
    path: jsonOutPath,
    pageCount: data.meta.pageCount,
    pageCountAfterClean: data.meta.pageCountAfterClean,
    lineCount: data.meta.lineCount,
    bytes: fs.statSync(jsonOutPath).size
  };
}

module.exports = {
  convertPdfFileToJson,
  extractPagesAsJson,
  writePdfJson,
  cleanPages,
  toCompactForm,
  isNoiseLine
};
