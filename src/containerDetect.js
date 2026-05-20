/**
 * Container detection — the single source of truth for "what visual box does
 * this text live inside?" Shared by src/pdfToJson.js (extract) and
 * src/pdfOverlay.js (render) so the line/container assignments agree.
 *
 * Why this exists:
 *   Before this module, both extract and overlay grouped text purely by Y
 *   proximity. That happily merged text from completely separate containers
 *   (e.g., the "© 2023 SAP SE..." footer and the bullet "• none" inside an
 *   info-card sidebar above it), because both lines lacked a sentence-ending
 *   punctuation and were close together in Y. The result was wrong lines in
 *   the JSON and overlay text drawn in the wrong place.
 *
 * What it does:
 *   For each page, read the vector operator list and collect explicit
 *   rectangles (and rectangle-shaped closed paths) as "containers". pdfjs
 *   already gives us the path bounding box in PAGE COORDINATES via the third
 *   argument of `constructPath` (`minMax = [minX, maxX, minY, maxY]`), so we
 *   don't have to track the current transform matrix ourselves.
 *
 *   We filter out:
 *     - degenerate paths (lines / dots / very thin strokes)
 *     - the full-page background fill (covers > 85% of page area)
 *   What remains is the set of meaningful boxes: callout frames, sidebar
 *   panels, diagram nodes, table cell borders, header/footer bands.
 *
 * Coordinate system note:
 *   PDF page coordinates: Y grows upward from bottom. textContent items use
 *   `transform[4..5] = (x, y)` in the same system. We keep everything in PDF
 *   coords here; conversion to the rendered viewport happens elsewhere.
 */

const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

const MIN_CONTAINER_SIDE = 5;           // points; reject lines/dots
const FULL_PAGE_AREA_RATIO = 0.85;      // reject background fills
const CONTAINMENT_EPSILON = 1.0;        // points; bbox membership slack

/**
 * Extract all rectangular containers from a pdfjs page object.
 *
 * @param {object} page - pdfjs PDFPageProxy (from doc.getPage(n))
 * @returns {Promise<Array<{
 *   id: number,
 *   kind: "rect" | "path",
 *   bbox: { x: number, y: number, width: number, height: number },
 *   area: number,
 *   depth: number
 * }>>}
 */
async function getPageContainers(page) {
  const OPS = pdfjsLib.OPS;
  const viewport = page.getViewport({ scale: 1.0 });
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;
  const pageArea = pageWidth * pageHeight;

  let opList;
  try {
    opList = await page.getOperatorList();
  } catch {
    return [];
  }

  const raw = [];
  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const fn = opList.fnArray[i];

    // pdfjs typically wraps rectangle ops inside a constructPath whose third
    // arg is the page-space bbox. That's the only signal we need here.
    if (fn === OPS.constructPath) {
      const args = opList.argsArray[i];
      if (!Array.isArray(args) || args.length < 3) continue;
      const innerOps = args[0];
      const minMax = args[2];
      if (!Array.isArray(minMax) || minMax.length < 4) continue;
      const [minX, maxX, minY, maxY] = minMax;
      const w = maxX - minX;
      const h = maxY - minY;
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
      if (w < MIN_CONTAINER_SIDE || h < MIN_CONTAINER_SIDE) continue;
      if (w * h > pageArea * FULL_PAGE_AREA_RATIO) continue;
      const hasRectOp = Array.isArray(innerOps) && innerOps.includes(OPS.rectangle);
      raw.push({
        kind: hasRectOp ? "rect" : "path",
        bbox: { x: minX, y: minY, width: w, height: h },
        area: w * h
      });
    } else if (fn === OPS.rectangle) {
      // Bare rectangle op (rare — usually consolidated into constructPath).
      const args = opList.argsArray[i];
      if (!Array.isArray(args) || args.length < 4) continue;
      const [x, y, w, h] = args;
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
      if (w < MIN_CONTAINER_SIDE || h < MIN_CONTAINER_SIDE) continue;
      if (w * h > pageArea * FULL_PAGE_AREA_RATIO) continue;
      raw.push({
        kind: "rect",
        bbox: { x, y, width: w, height: h },
        area: w * h
      });
    }
  }

  return classifyContainers(raw);
}

function classifyContainers(raw) {
  if (!raw.length) return [];
  // Outer containers first so nested ones get higher ids. id is stable per page.
  const sorted = [...raw].sort((a, b) => b.area - a.area);
  for (let i = 0; i < sorted.length; i += 1) {
    sorted[i].id = i + 1;
  }
  // Depth = how many other containers strictly enclose this one.
  for (const c of sorted) {
    let depth = 0;
    for (const other of sorted) {
      if (other === c) continue;
      if (other.area <= c.area) continue;
      if (contains(other.bbox, c.bbox, CONTAINMENT_EPSILON)) depth += 1;
    }
    c.depth = depth;
  }
  return sorted;
}

function contains(outer, inner, eps = CONTAINMENT_EPSILON) {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

/**
 * Find the smallest container that fully contains the given item box.
 * Items rest on a baseline; we treat their box as (x, y - descent .. y + ascent)
 * where the caller has already computed those bounds. Returns containerId or
 * `null` if the item lies on the bare page.
 *
 * @param {{x:number,y:number,width:number,height:number}} itemBox
 * @param {Array<{id:number,bbox:object,area:number}>} containers
 * @returns {number|null}
 */
function assignItemToContainer(itemBox, containers) {
  let best = null;
  for (const c of containers) {
    if (!contains(c.bbox, itemBox, CONTAINMENT_EPSILON)) continue;
    if (!best || c.area < best.area) best = c;
  }
  return best ? best.id : null;
}

/**
 * Convenience: build a quick lookup `containerId -> bbox`.
 * @param {Array} containers
 * @returns {Map<number,{x,y,width,height}>}
 */
function buildContainerIndex(containers) {
  const map = new Map();
  for (const c of containers) map.set(c.id, c.bbox);
  return map;
}

module.exports = {
  getPageContainers,
  assignItemToContainer,
  buildContainerIndex,
  contains,
  CONTAINMENT_EPSILON,
  MIN_CONTAINER_SIDE
};
