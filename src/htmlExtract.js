const cheerio = require("cheerio");

const COURSE_CODE_REGEX = /\b([A-Z]{2,}\d{3,}[A-Z]?)\b/;

function normalizeBadgeStatus(text) {
  const v = String(text || "").trim().toLowerCase();
  if (!v) return "unknown";
  if (/passed|complete/.test(v)) return "passed";
  if (/active|current|ongoing|in-progress/.test(v)) return "pending";
  if (/pending/.test(v)) return "pending";
  if (/locked/.test(v)) return "locked";
  return "unknown";
}

function deriveCourseCode(value) {
  const m = String(value || "").toUpperCase().match(COURSE_CODE_REGEX);
  return m ? m[1] : "";
}

function extractCurriculumCourses(html) {
  const $ = cheerio.load(html);
  const nodes = [];

  $("table tbody tr").each((rowIdx, tr) => {
    $(tr)
      .children("td")
      .each((colIdx, td) => {
        $(td)
          .find("button.card-course")
          .each((_, btn) => {
            const $btn = $(btn);
            const code = ($btn.attr("course") || deriveCourseCode($btn.text())).toUpperCase();
            if (!code) return;
            const description = $btn.attr("description") || "";
            const dept = ($btn.attr("department") || "").toUpperCase();
            const badgeText = $btn.find(".badge").text();
            const status = normalizeBadgeStatus(badgeText);
            const title = dept ? `${dept} ${code}` : code;
            nodes.push({
              href: "",
              courseCode: code,
              title,
              description: description.trim(),
              department: dept,
              status,
              column: colIdx,
              row: rowIdx
            });
          });
      });
  });

  return nodes;
}

function clusterByColumn(nodes) {
  const map = new Map();
  for (const node of nodes) {
    const key = node.column;
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(node);
  }
  const columns = Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([col, list], idx) => ({
      index: idx,
      column: col,
      nodes: list,
      hasPending: list.some((n) => n.status === "pending" || n.status === "unknown"),
      allPassed: list.length > 0 && list.every((n) => n.status === "passed")
    }));
  return columns;
}

function pickCurrentTermForRegular(columns) {
  for (let i = 0; i < columns.length; i += 1) {
    const prior = columns.slice(0, i);
    const priorAllPassed = prior.length === 0 || prior.every((c) => c.allPassed);
    if (priorAllPassed && columns[i].hasPending) {
      return columns[i];
    }
  }
  return null;
}

function extractCourseModules(html, options = {}) {
  const $ = cheerio.load(html);
  const currentCourseCode = (options.currentCourseCode || "").toUpperCase();
  const mode = options.scanMode || "strict";
  const out = [];

  $("li[data-role='MBG-LINE']").each((_, li) => {
    const $li = $(li);
    const rowCourse = ($li.attr("data-course") || "").trim().toUpperCase();
    const status = ($li.attr("data-status") || "").trim().toLowerCase();
    const moduleId = ($li.attr("module-id") || "").trim();
    const courseId = ($li.attr("course-id") || "").trim();
    const moduleDataId = ($li.attr("data-module") || "").trim();

    const titleEl = $li.find(".module-title").first().length
      ? $li.find(".module-title").first()
      : $li.find("a.MBG-COURSE-HEADING-MODAL").first();
    const title = (titleEl.text() || $li.text() || "").trim().replace(/\s+/g, " ");

    if (!title || !moduleId || !courseId) return;

    if (currentCourseCode && rowCourse && rowCourse !== currentCourseCode) return;

    if (
      mode === "strict" &&
      status &&
      status !== "active" &&
      status !== "pending" &&
      status !== "current"
    ) {
      return;
    }

    out.push({
      href: "",
      title,
      moduleId,
      moduleDataId,
      courseId,
      status,
      rowCourse
    });
  });

  return out;
}

function extractModuleAssetUrls(html) {
  const $ = cheerio.load(html);
  // core-fetch-modules.php returns the WHOLE course's modules in one HTML blob.
  // The currently-requested module is the only one rendered open — its
  // accordion body has class `.module-body.collapse.show`. Other modules are
  // present as `.module-body.collapse` (without `.show`). If we don't scope to
  // the open one, every module ends up pointing to module 1's PDF.
  let scope = $(".module-body.collapse.show");
  if (!scope.length) {
    // Fallback: try `.show` alone, then the whole document as a last resort.
    scope = $(".collapse.show").length ? $(".collapse.show") : $.root();
  }
  const urls = new Set();
  scope.find("[endpoint-url]").each((_, el) => {
    const v = ($(el).attr("endpoint-url") || "").trim();
    if (v) urls.add(v);
  });
  return Array.from(urls);
}

function pickPresentationUrl(urls) {
  if (!urls.length) return "";
  const pdfs = urls.filter((u) => /\.pdf(\?|$)/i.test(u));
  if (pdfs.length) return pdfs[0];
  const ppt = urls.find((u) => /\.pptx?(\?|$)/i.test(u));
  return ppt || urls[0];
}

module.exports = {
  extractCurriculumCourses,
  clusterByColumn,
  pickCurrentTermForRegular,
  extractCourseModules,
  extractModuleAssetUrls,
  pickPresentationUrl,
  deriveCourseCode
};
