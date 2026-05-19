/**
 * Visual-fidelity overlay: takes a source PDF + the translated JSON, produces
 * a new PDF where all original images, charts, and vector content are preserved
 * 1:1 — only the text is white-boxed out and replaced with the translation at
 * the same coordinates.
 *
 * Why this exists:
 *   The pptxgenjs approach throws away all visual design (background images,
 *   color schemes, charts) and emits a clean text-only deck. Students need
 *   the slide to LOOK identical to the source.
 *
 * Approach:
 *   1. Use pdfjs-dist to extract every text item from the source PDF, with
 *      precise (x, y, width, fontSize) positions.
 *   2. Apply the same cleanup as src/pdfToJson.js (line grouping + reflow +
 *      noise drop) so the line indices align with the translated JSON.
 *   3. While cleaning, remember which source-PDF items contributed to each
 *      cleaned line (so we know which boxes to cover).
 *   4. For each translated line, white-box the source items it replaces and
 *      draw the translated string at the first item's position using pdf-lib.
 *
 * Limitations (acknowledged):
 *   - White boxes appear over colored backgrounds (e.g., dark header bars).
 *     A future improvement is sampling the underlying color before covering.
 *   - Helvetica is used as the overlay font; original typeface is not matched.
 *   - Long translations may overflow the source bbox; we use maxWidth +
 *     shrink-to-fit by reducing fontSize if needed.
 */

const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

const LINE_Y_TOLERANCE = 3;
const PURE_NOISE = /^[\s\d\W]{0,3}$/;
const SENTENCE_END = /[.!?…:](["'”’])?\s*$/;
const BULLET_OR_NUMBER_START = /^[\s]*([•·●▪■◆\-*]|\d+[.)\s]|[A-Z][.)\s]|\([a-z0-9]+\))/;

// --- Fit-planner tunables ---
const MIN_FONT_SIZE = 6;            // never shrink below this
const LINE_HEIGHT_RATIO = 1.15;     // line-spacing relative to fontSize
const ASCENT_RATIO = 0.8;           // baseline offset from top of line box
const PAGE_SAFE_MARGINS = { top: 18, right: 18, bottom: 18, left: 18 };
const COVER_PADDING = 0.5;          // small extra padding around cover box
const SHRINK_STEP = 0.5;            // font-size step when shrinking
const FIT_EPSILON = 1.0;            // measurement slack to absorb rounding

function isNoiseLine(text) {
  if (!text) return true;
  const t = String(text).trim();
  if (!t) return true;
  if (PURE_NOISE.test(t)) return true;
  if (/^\d{1,3}$/.test(t)) return true;
  if (/^[•·●▪■◆\-*]+$/.test(t)) return true;
  return false;
}

function isBoldFont(fontName) {
  return /bold|black|heavy|semibold|extrabold/i.test(fontName || "");
}

// Extract per-page raw items + group into lines with bboxes
async function extractPagesWithBoxes(pdfBuffer) {
  let data;
  if (Buffer.isBuffer(pdfBuffer)) {
    data = new Uint8Array(pdfBuffer.buffer, pdfBuffer.byteOffset, pdfBuffer.byteLength);
  } else {
    data = pdfBuffer;
  }
  const doc = await pdfjsLib.getDocument({
    data, disableWorker: true, isEvalSupported: false, verbosity: 0
  }).promise;

  const pages = [];
  const allFontSizes = [];

  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1.0 });
    const content = await page.getTextContent();
    const buckets = [];
    for (const item of content.items) {
      if (!item || !item.str) continue;
      const text = item.str;
      if (!text.trim() && text !== " ") continue;
      const fontSize = Math.abs(item.transform?.[0] ?? item.height ?? 12);
      const x = item.transform?.[4] ?? 0;
      const y = item.transform?.[5] ?? 0;
      const width = typeof item.width === "number" ? item.width : text.length * fontSize * 0.5;
      const fontName = item.fontName || "";
      const existing = buckets.find((b) => Math.abs(b.y - y) <= LINE_Y_TOLERANCE);
      if (existing) {
        existing.items.push({ text, x, y, fontSize, fontName, width });
        existing.y = (existing.y + y) / 2;
      } else {
        buckets.push({ y, items: [{ text, x, y, fontSize, fontName, width }] });
      }
    }
    // Sort top-to-bottom by PDF Y (high Y = top of page in PDF coords)
    buckets.sort((a, b) => b.y - a.y);
    for (const b of buckets) {
      b.items.sort((a, c) => a.x - c.x);
      const fs = Math.max(...b.items.map((i) => i.fontSize), 0);
      if (fs > 0) allFontSizes.push(fs);
    }
    pages.push({ pageNumber: p, pageWidth: viewport.width, pageHeight: viewport.height, buckets });
  }
  return { pageCount: doc.numPages, pages, allFontSizes };
}

function joinItemsInLine(items) {
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

function lineBBox(items) {
  // Compute a bounding box in PDF coordinates (Y grows upward from bottom).
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity, minY = Infinity;
  let maxFs = 0;
  for (const it of items) {
    const w = it.width != null ? it.width : it.text.length * it.fontSize * 0.5;
    if (it.x < minX) minX = it.x;
    if (it.x + w > maxX) maxX = it.x + w;
    // Baseline at it.y; ascent ~ fontSize*0.8, descent ~ fontSize*0.2
    const top = it.y + it.fontSize * 0.85;
    const bottom = it.y - it.fontSize * 0.25;
    if (top > maxY) maxY = top;
    if (bottom < minY) minY = bottom;
    if (it.fontSize > maxFs) maxFs = it.fontSize;
  }
  return {
    x: minX,
    y: minY, // bottom-left in PDF coords
    width: maxX - minX,
    height: maxY - minY,
    baselineY: items[0]?.y || 0,
    fontSize: maxFs
  };
}

function classifyLine(items, baselineFontSize) {
  const lineFs = Math.max(...items.map((i) => i.fontSize), 0);
  const hasBold = items.some((i) => isBoldFont(i.fontName));
  const text = joinItemsInLine(items);
  if (!text) return null;
  let type = "p";
  if (baselineFontSize > 0) {
    if (lineFs >= baselineFontSize * 1.25) type = "h";
    else if (hasBold && lineFs >= baselineFontSize * 1.05 && text.length < 120) type = "h";
    else if (hasBold && text.length < 80 && /^[A-Z0-9 \-:.,]+$/.test(text)) type = "h";
  }
  return { text, type, fontSize: lineFs };
}

/**
 * Apply the same cleanup as src/pdfToJson.js but KEEP each cleaned line's
 * source bbox(es). Returns one cleaned-page array per source page.
 *
 *   cleanedPages[i] = {
 *     pageNumber, pageWidth, pageHeight,
 *     lines: [
 *       { type: "h"|"p", text, sourceBoxes: [bbox, ...], fontSize }
 *     ]
 *   }
 *
 * If a paragraph was reflowed from two source lines, sourceBoxes has two
 * entries (we'll white-box both, draw text at the first).
 */
function buildCleanedPagesWithBoxes(rawPages, allFontSizes) {
  const baseline = median(allFontSizes);
  const out = [];
  for (const pg of rawPages) {
    // First pass: build per-bucket cleaned-line candidates with bbox.
    const candidates = [];
    for (const b of pg.buckets) {
      const classified = classifyLine(b.items, baseline);
      if (!classified || !classified.text) continue;
      if (isNoiseLine(classified.text)) continue;
      candidates.push({
        type: classified.type,
        text: classified.text,
        sourceBoxes: [lineBBox(b.items)],
        fontSize: classified.fontSize
      });
    }
    // Second pass: reflow consecutive `p` lines that don't end with sentence
    // terminator and don't start with bullet/number.
    const merged = [];
    for (const el of candidates) {
      const prev = merged[merged.length - 1];
      if (
        prev &&
        prev.type === "p" &&
        el.type === "p" &&
        !SENTENCE_END.test(prev.text) &&
        !BULLET_OR_NUMBER_START.test(el.text)
      ) {
        prev.text = `${prev.text} ${el.text.trim()}`.replace(/\s+/g, " ");
        prev.sourceBoxes.push(...el.sourceBoxes);
        continue;
      }
      merged.push({ ...el, sourceBoxes: [...el.sourceBoxes] });
    }
    if (merged.length) {
      out.push({
        pageNumber: pg.pageNumber,
        pageWidth: pg.pageWidth,
        pageHeight: pg.pageHeight,
        lines: merged
      });
    }
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function unionBoxes(boxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pickTextForLine(line) {
  if (!line) return "";
  if (line.h !== undefined) return String(line.h || "");
  if (line.p !== undefined) return String(line.p || "");
  return "";
}

// pdf-lib's standard fonts use WinAnsi encoding which doesn't support many
// unicode characters (bullets, box symbols, smart quotes, em-dashes, ñ).
// Replace with ASCII-safe equivalents so the overlay never crashes.
const SAFE_CHAR_MAP = {
  "•": "*", "·": "*", "●": "*", "◆": "*", "▪": "-", "■": "-",
  "❑": "[ ]", "❒": "[ ]", "❏": "[ ]", "✓": "[x]", "✔": "[x]", "✗": "[ ]", "✘": "[ ]",
  "—": "-", "–": "-",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "…": "...",
  "→": "->", "←": "<-", "↑": "^", "↓": "v",
  "©": "(c)", "®": "(R)", "™": "(TM)",
  "°": " deg",
  "×": "x", "÷": "/",
  "±": "+/-", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~",
  "ñ": "n", "Ñ": "N",
  "é": "e", "è": "e", "ê": "e", "ë": "e", "É": "E", "È": "E",
  "á": "a", "à": "a", "â": "a", "ä": "a", "Á": "A", "À": "A",
  "í": "i", "ì": "i", "î": "i", "ï": "i", "Í": "I",
  "ó": "o", "ò": "o", "ô": "o", "ö": "o", "Ó": "O",
  "ú": "u", "ù": "u", "û": "u", "ü": "u", "Ú": "U",
  "ç": "c", "Ç": "C",
  " ": " " // non-breaking space
};

function sanitizeForWinAnsi(s) {
  if (!s) return "";
  let out = "";
  for (const ch of String(s)) {
    if (SAFE_CHAR_MAP[ch] !== undefined) {
      out += SAFE_CHAR_MAP[ch];
      continue;
    }
    const code = ch.charCodeAt(0);
    // ASCII printable + common Latin-1 supplement (which WinAnsi covers)
    if (code >= 0x20 && code <= 0x7E) {
      out += ch;
    } else if (code >= 0xA0 && code <= 0xFF) {
      // Latin-1 supplement — mostly safe in WinAnsi
      out += ch;
    } else {
      // Drop everything else (other languages' scripts, math symbols, etc.)
      out += "?";
    }
  }
  return out;
}

/**
 * Greedy word-wrap. Pack words until next word would exceed maxWidth.
 * If a single word is wider than maxWidth on its own, emit it as its own
 * line (mild overflow accepted; letter-splitting reads worse).
 *
 * @param {string} text
 * @param {object} font - pdf-lib font (must support widthOfTextAtSize)
 * @param {number} fontSize
 * @param {number} maxWidth
 * @returns {string[]}
 */
function wrapTextIntoLines(text, font, fontSize, maxWidth) {
  if (!text) return [];
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    let w;
    try {
      w = font.widthOfTextAtSize(candidate, fontSize);
    } catch {
      // If measurement fails on a char (shouldn't after sanitize), force break.
      w = Number.POSITIVE_INFINITY;
    }
    if (w <= maxWidth + FIT_EPSILON) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word; // start a new line with the over-wide word
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Decide how to render one translated line over the source bbox.
 *
 * Tries: keep original fontSize (no wrap) -> wrap at original fontSize ->
 *        shrink fontSize stepwise -> truncate -> give up.
 *
 * Returns a plan describing exactly what to draw and where.
 *
 * @param {object} params
 * @param {string} params.text - already sanitized translated string
 * @param {Array<{x,y,width,height,baselineY,fontSize}>} params.sourceBoxes
 * @param {object} params.font - pdf-lib font
 * @param {number} params.initialFontSize
 * @param {number} params.pageWidth
 * @param {number} params.pageHeight
 * @param {number|null} params.nextLineTopY - Y of next source line's TOP, or null
 * @param {{top:number,right:number,bottom:number,left:number}} params.pageMargins
 * @returns {{
 *   decision: "fit-original" | "wrap-fit" | "fit-shrunk" | "truncated" | "no-room",
 *   fontSize: number,
 *   lineHeight: number,
 *   wrappedLines: string[],
 *   drawAt: { x: number, baselineY: number },
 *   coverRect: { x: number, y: number, width: number, height: number },
 *   diagnostics: object
 * }}
 */
function planLineFit(params) {
  const {
    text,
    sourceBoxes,
    font,
    initialFontSize,
    pageWidth,
    pageHeight,
    nextLineTopY,
    pageMargins
  } = params;

  const firstBox = sourceBoxes[0];
  const union = unionBoxes(sourceBoxes);

  const availableLeft = Math.max(pageMargins.left, firstBox.x);
  const availableRight = pageWidth - pageMargins.right;
  const availableTop = union.y + union.height;
  const availableBottom = Math.max(
    pageMargins.bottom,
    nextLineTopY != null ? nextLineTopY + 2 : pageMargins.bottom
  );
  const availableWidth = Math.max(1, availableRight - availableLeft);
  const availableHeight = Math.max(0, availableTop - availableBottom);

  const srcChars = sourceBoxes
    .reduce((s, b) => s + (b.text ? b.text.length : 0), 0); // best-effort; may be 0 if not tracked
  const trnChars = String(text || "").length;
  const ratio = srcChars > 0 ? trnChars / srcChars : null;

  const attempts = [];
  const buildCoverRect = (wrappedLines, fontSize) => {
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const requiredHeight = wrappedLines.length * lineHeight;
    // Cover the rendered area (which can extend BELOW the source bbox)
    let maxLineWidth = 0;
    for (const ln of wrappedLines) {
      try {
        const w = font.widthOfTextAtSize(ln, fontSize);
        if (w > maxLineWidth) maxLineWidth = w;
      } catch {
        /* ignore */
      }
    }
    const coverWidth = Math.max(union.width, maxLineWidth) + COVER_PADDING * 2;
    return {
      x: availableLeft - COVER_PADDING,
      y: availableTop - requiredHeight - COVER_PADDING,
      width: coverWidth,
      height: requiredHeight + COVER_PADDING * 2
    };
  };
  const buildDrawAt = (fontSize) => ({
    x: availableLeft,
    baselineY: availableTop - fontSize * ASCENT_RATIO
  });

  // 1. Try original fontSize, single line first (best fidelity)
  try {
    const singleLineWidth = font.widthOfTextAtSize(text, initialFontSize);
    if (singleLineWidth <= availableWidth + FIT_EPSILON) {
      const wrappedLines = [text];
      const lineHeight = initialFontSize * LINE_HEIGHT_RATIO;
      if (lineHeight <= availableHeight + FIT_EPSILON) {
        return {
          decision: "fit-original",
          fontSize: initialFontSize,
          lineHeight,
          wrappedLines,
          drawAt: buildDrawAt(initialFontSize),
          coverRect: buildCoverRect(wrappedLines, initialFontSize),
          diagnostics: {
            srcChars, trnChars, ratio,
            srcWidth: union.width,
            trnSingleLineWidth: singleLineWidth,
            attemptedFontSizes: [initialFontSize],
            finalLines: 1
          }
        };
      }
    }
  } catch {
    /* fall through to wrap/shrink */
  }

  // 2. Try wrap at original fontSize, then progressively shrink
  for (
    let fontSize = initialFontSize;
    fontSize >= MIN_FONT_SIZE;
    fontSize -= SHRINK_STEP
  ) {
    const wrappedLines = wrapTextIntoLines(text, font, fontSize, availableWidth);
    if (!wrappedLines.length) break;
    attempts.push(fontSize);
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const requiredHeight = wrappedLines.length * lineHeight;
    if (requiredHeight <= availableHeight + FIT_EPSILON) {
      let decision;
      if (fontSize === initialFontSize) {
        decision = wrappedLines.length === 1 ? "fit-original" : "wrap-fit";
      } else {
        decision = "fit-shrunk";
      }
      return {
        decision,
        fontSize,
        lineHeight,
        wrappedLines,
        drawAt: buildDrawAt(fontSize),
        coverRect: buildCoverRect(wrappedLines, fontSize),
        diagnostics: {
          srcChars, trnChars, ratio,
          srcWidth: union.width,
          attemptedFontSizes: attempts.slice(),
          finalLines: wrappedLines.length
        }
      };
    }
  }

  // 3. Couldn't fit at MIN_FONT_SIZE — truncate
  const wrappedAtMin = wrapTextIntoLines(text, font, MIN_FONT_SIZE, availableWidth);
  const minLineHeight = MIN_FONT_SIZE * LINE_HEIGHT_RATIO;
  const maxLines = Math.floor(availableHeight / minLineHeight);
  if (maxLines >= 1 && wrappedAtMin.length > 0) {
    const truncatedLines = wrappedAtMin.slice(0, maxLines);
    const lastIdx = truncatedLines.length - 1;
    // Append ellipsis (sanitized form) to the last visible line
    let lastLine = truncatedLines[lastIdx];
    const ellipsis = "...";
    while (
      lastLine.length > 0 &&
      font.widthOfTextAtSize(`${lastLine}${ellipsis}`, MIN_FONT_SIZE) > availableWidth + FIT_EPSILON
    ) {
      lastLine = lastLine.slice(0, -1);
    }
    truncatedLines[lastIdx] = `${lastLine}${ellipsis}`;
    return {
      decision: "truncated",
      fontSize: MIN_FONT_SIZE,
      lineHeight: minLineHeight,
      wrappedLines: truncatedLines,
      drawAt: buildDrawAt(MIN_FONT_SIZE),
      coverRect: buildCoverRect(truncatedLines, MIN_FONT_SIZE),
      diagnostics: {
        srcChars, trnChars, ratio,
        srcWidth: union.width,
        attemptedFontSizes: attempts.slice(),
        finalLines: truncatedLines.length,
        truncatedFrom: wrappedAtMin.length
      }
    };
  }

  // 4. No room at all — return a no-op draw plan; caller will still cover source
  return {
    decision: "no-room",
    fontSize: MIN_FONT_SIZE,
    lineHeight: minLineHeight,
    wrappedLines: [],
    drawAt: buildDrawAt(MIN_FONT_SIZE),
    coverRect: {
      x: union.x - COVER_PADDING,
      y: union.y - COVER_PADDING,
      width: union.width + COVER_PADDING * 2,
      height: union.height + COVER_PADDING * 2
    },
    diagnostics: {
      srcChars, trnChars, ratio,
      srcWidth: union.width,
      attemptedFontSizes: attempts.slice(),
      finalLines: 0
    }
  };
}

/**
 * Main entry: overlay translation onto source PDF.
 *
 * @param {string} sourcePdfPath
 * @param {object} translatedJson - the compact-v1 translated JSON
 * @param {string} outputPdfPath
 * @param {object} [opts] - { log }
 */
async function overlayTranslation(sourcePdfPath, translatedJson, outputPdfPath, opts = {}) {
  const log = opts.log || (() => {});
  const srcBuf = fs.readFileSync(sourcePdfPath);
  const pdfDoc = await PDFDocument.load(srcBuf);
  pdfDoc.registerFontkit(fontkit);

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const { pages: rawSourcePages, allFontSizes } = await extractPagesWithBoxes(srcBuf);
  const cleanedSourcePages = buildCleanedPagesWithBoxes(rawSourcePages, allFontSizes);

  // Index translated pages by page number for fast lookup
  const trnByPage = new Map();
  for (const p of translatedJson.pages || []) {
    trnByPage.set(p.n, p);
  }

  const pages = pdfDoc.getPages();
  let totalOverlays = 0;
  let totalSkipped = 0;
  const fit = { fitOriginal: 0, wrapFit: 0, fitShrunk: 0, truncated: 0, noRoom: 0 };

  for (const srcPage of cleanedSourcePages) {
    const pdfPage = pages[srcPage.pageNumber - 1];
    if (!pdfPage) continue;
    const trnPage = trnByPage.get(srcPage.pageNumber);
    if (!trnPage) {
      totalSkipped += srcPage.lines.length;
      continue;
    }

    const pageWidth = pdfPage.getWidth();
    const pageHeight = pdfPage.getHeight();

    // Pair by index: source cleaned line N ↔ translated line N.
    const pairs = Math.min(srcPage.lines.length, trnPage.lines.length);
    for (let i = 0; i < pairs; i += 1) {
      const srcLine = srcPage.lines[i];
      const trnLine = trnPage.lines[i];
      const trnText = sanitizeForWinAnsi(pickTextForLine(trnLine));
      if (!trnText) continue;

      const isHeading = trnLine.h !== undefined;
      const font = isHeading ? helvBold : helv;
      const initialFontSize = srcLine.fontSize || 12;

      // Look ahead at the NEXT source line's top to determine the vertical
      // floor we can use without colliding with the line below us.
      const nextSrcLine = srcPage.lines[i + 1];
      const nextLineTopY = nextSrcLine
        ? unionBoxes(nextSrcLine.sourceBoxes).y + unionBoxes(nextSrcLine.sourceBoxes).height
        : null;

      const plan = planLineFit({
        text: trnText,
        sourceBoxes: srcLine.sourceBoxes,
        font,
        initialFontSize,
        pageWidth,
        pageHeight,
        nextLineTopY,
        pageMargins: PAGE_SAFE_MARGINS
      });

      // 1. Always cover the source bbox (so original text is hidden) AND
      //    extend down if the plan's wrapped content is taller than the
      //    source. Two-rect strategy: cover the original boxes precisely,
      //    plus add an extra rect for the overflow region if any.
      for (const box of srcLine.sourceBoxes) {
        pdfPage.drawRectangle({
          x: box.x - COVER_PADDING,
          y: box.y - COVER_PADDING,
          width: box.width + COVER_PADDING * 2,
          height: box.height + COVER_PADDING * 2,
          color: rgb(1, 1, 1),
          borderWidth: 0
        });
      }
      // Extra cover for content drawn below the source bbox (wrap overflow)
      const srcUnion = unionBoxes(srcLine.sourceBoxes);
      const planBottom = plan.coverRect.y;
      const srcBottom = srcUnion.y;
      if (planBottom < srcBottom - 0.5) {
        pdfPage.drawRectangle({
          x: plan.coverRect.x,
          y: plan.coverRect.y,
          width: plan.coverRect.width,
          height: srcBottom - plan.coverRect.y,
          color: rgb(1, 1, 1),
          borderWidth: 0
        });
      }

      // 2. Draw each wrapped line at its own baseline.
      let drewAny = false;
      try {
        for (let k = 0; k < plan.wrappedLines.length; k += 1) {
          const lineText = plan.wrappedLines[k];
          const baselineY = plan.drawAt.baselineY - k * plan.lineHeight;
          pdfPage.drawText(lineText, {
            x: plan.drawAt.x,
            y: baselineY,
            size: plan.fontSize,
            font,
            color: rgb(0, 0, 0)
          });
          drewAny = true;
        }
        if (drewAny) totalOverlays += 1;
        else totalSkipped += 1;
      } catch {
        // pdf-lib threw on an unsupported character that slipped past the
        // sanitizer. Skip the text draw (cover already applied above).
        totalSkipped += 1;
      }

      // 3. Tally by decision.
      switch (plan.decision) {
        case "fit-original": fit.fitOriginal += 1; break;
        case "wrap-fit":     fit.wrapFit += 1; break;
        case "fit-shrunk":   fit.fitShrunk += 1; break;
        case "truncated":    fit.truncated += 1; break;
        case "no-room":      fit.noRoom += 1; break;
        default: break;
      }
    }
  }

  log(
    `[pdfOverlay] ${path.basename(outputPdfPath)} — ` +
    `${totalOverlays} overlays, ${totalSkipped} skipped ` +
    `(${fit.fitOriginal} fit / ${fit.wrapFit} wrap / ${fit.fitShrunk} shrunk / ` +
    `${fit.truncated} trunc / ${fit.noRoom} no-room)`
  );

  const out = await pdfDoc.save();
  fs.mkdirSync(path.dirname(outputPdfPath), { recursive: true });
  fs.writeFileSync(outputPdfPath, out);
  return {
    path: outputPdfPath,
    overlays: totalOverlays,
    skipped: totalSkipped,
    fit
  };
}

module.exports = {
  overlayTranslation,
  extractPagesWithBoxes,
  buildCleanedPagesWithBoxes
};
