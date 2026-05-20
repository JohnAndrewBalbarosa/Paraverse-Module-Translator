const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { getPageContainers, assignItemToContainer } = require("./containerDetect");

/**
 * Convert a PDF into a per-page, line-by-line JSON structure suitable for
 * sending to an LLM for translation. The LLM is expected to replace each
 * element's `text` field with the translation and return the same shape.
 *
 * Output schema (compact-v2):
 * {
 *   meta: { sourceFile, course, module, generatedAt, pageCount, schema: "compact-v2" },
 *   pages: [
 *     { n: 1, lines: [
 *       { h: "..." }              // heading, on bare page
 *       { p: "...", c: 3 }        // paragraph, inside container id 3
 *     ] }
 *   ]
 * }
 *
 * Container awareness:
 *   Each line carries an optional `c` field = container id. Lines from
 *   different containers are NEVER merged during reflow even if their Y
 *   coordinates are close. This is what keeps the footer copyright line
 *   from being glued onto the bullet text above it.
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

/**
 * Build a per-item "approximate bbox" used for container-membership tests.
 * Items report a baseline (x, y) + width; we extend slightly above/below the
 * baseline by fontSize fractions so the bbox covers ascenders/descenders.
 */
function itemBBox(it) {
  const w = typeof it.width === "number" ? it.width : it.text.length * it.fontSize * 0.5;
  return {
    x: it.x,
    y: it.y - it.fontSize * 0.25,
    width: w,
    height: it.fontSize * 1.1
  };
}

function groupItemsIntoLines(items, containers) {
  // Items have { str, transform: [a,b,c,d,x,y], width, height, fontName }
  // Y in PDF coords increases upward. Group by Y proximity, then split each
  // bucket by container id so items from different visual boxes never end up
  // in the same logical line.
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
    const enriched = { text, x, y, fontSize, fontName, width };
    const containerId = containers && containers.length
      ? assignItemToContainer(itemBBox(enriched), containers)
      : null;
    enriched.containerId = containerId;
    const existing = buckets.find((b) => Math.abs(b.y - y) <= LINE_Y_TOLERANCE);
    if (existing) {
      existing.items.push(enriched);
      existing.y = (existing.y + y) / 2; // running average
    } else {
      buckets.push({ y, items: [enriched] });
    }
  }
  // Split each Y-bucket into per-container sub-buckets.
  const split = [];
  for (const b of buckets) {
    const groups = new Map();
    for (const it of b.items) {
      const key = it.containerId == null ? "null" : String(it.containerId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    for (const [key, groupItems] of groups.entries()) {
      groupItems.sort((a, b2) => a.x - b2.x);
      split.push({
        y: b.y,
        items: groupItems,
        containerId: key === "null" ? null : Number(key)
      });
    }
  }
  // Sort top-to-bottom (high Y first). For ties, sort by container id so a
  // stable reading order emerges (null containers first, then id 1, 2, ...).
  split.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 0.001) return b.y - a.y;
    const ca = a.containerId == null ? -1 : a.containerId;
    const cb = b.containerId == null ? -1 : b.containerId;
    return ca - cb;
  });
  return split;
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
  return {
    type,
    text,
    fontSize: Math.round(lineFontSize * 10) / 10,
    containerId: line.containerId == null ? null : line.containerId
  };
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
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
    verbosity: 0
  });
  const doc = await loadingTask.promise;
  const pages = [];
  const containerStats = { perPage: [], totalContainers: 0, splitsPrevented: 0 };

  // First pass: collect all line font sizes across the document to compute
  // a stable baseline that won't be skewed by a single oversized cover page.
  const allLineSizes = [];
  const perPageRawLines = [];

  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const containers = await getPageContainers(page);
    containerStats.perPage.push(containers.length);
    containerStats.totalContainers += containers.length;

    // Track how many Y-buckets got split by container awareness — useful
    // signal in the checker report.
    const preSplitBuckets = new Set();
    for (const item of content.items) {
      if (!item || !item.str || !item.str.trim()) continue;
      const y = item.transform?.[5] ?? 0;
      // crude bucket key, same tolerance
      preSplitBuckets.add(Math.round(y / LINE_Y_TOLERANCE));
    }
    const lines = groupItemsIntoLines(content.items, containers);
    if (lines.length > preSplitBuckets.size) {
      containerStats.splitsPrevented += lines.length - preSplitBuckets.size;
    }
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
        elements.push({
          type: classified.type,
          text: classified.text,
          containerId: classified.containerId
        });
      }
    }
    pages.push({ page: p, elements });
  }

  return { pageCount: doc.numPages, pages, containerStats };
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
  // continuation of A — but ONLY when both live in the same container. We
  // never merge across container boundaries even if Y + punctuation would
  // otherwise allow it.
  const merged = [];
  for (const el of elements) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.type === "paragraph" &&
      el.type === "paragraph" &&
      prev.containerId === el.containerId &&
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
  // Add { c: <containerId> } when the line belongs to a container so the
  // overlay step can constrain text to that visual region.
  return pages.map((page) => ({
    n: page.page,
    lines: page.elements.map((el) => {
      const base = el.type === "heading" ? { h: el.text } : { p: el.text };
      if (el.containerId != null) base.c = el.containerId;
      return base;
    })
  }));
}

function countLines(pages) {
  return pages.reduce((s, p) => s + (p.elements ? p.elements.length : p.lines.length), 0);
}

// ---------- Public API ----------

async function convertPdfFileToJson(pdfPath, meta = {}, opts = {}) {
  const buf = fs.readFileSync(pdfPath);
  const { pageCount, pages, containerStats } = await extractPagesAsJson(buf);

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
      schema: wantCleanCompact ? "compact-v2" : "verbose-v2",
      schemaHint: wantCleanCompact
        ? "pages[].lines[] is an array of { h: heading-text } or { p: paragraph-text }, optionally with { c: containerId } pointing at the visual box this line lives inside. Translate by replacing string values only; keep keys, order, and `c` field identical."
        : "pages[].elements[] has { type, text, containerId }. Translate the text field.",
      generatedAt: new Date().toISOString(),
      containerStats
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
    bytes: fs.statSync(jsonOutPath).size,
    containerStats: data.meta.containerStats
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
