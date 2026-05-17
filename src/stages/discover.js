/**
 * Stage: discover
 *
 * Responsibilities:
 *   - Fetch curriculum HTML from Paraverse
 *   - Parse out course nodes
 *   - Cluster nodes into term columns
 *   - Pick the current term (based on config.studentMode)
 *
 * Reads from context:  http, config
 * Writes to context:   curriculum = { nodes, columns, currentTerm }
 *
 * Skipped when:  context already has a curriculum (e.g., --use-saved path
 *                builds context directly from disk and bypasses discover)
 */

const {
  extractCurriculumCourses,
  clusterByColumn,
  pickCurrentTermForRegular
} = require("../htmlExtract");

const PARAVERSE_ORIGIN = "https://paraverse.feutech.edu.ph";

async function run(context, deps) {
  const { http, config } = context;
  const log = (deps && deps.log) || (() => {});

  const curriculumUrl = config.curriculumUrl || `${PARAVERSE_ORIGIN}/network-map/curriculum/`;
  const html = await http.fetchHtml(curriculumUrl);
  const nodes = extractCurriculumCourses(html);
  if (!nodes.length) {
    throw new Error("No course nodes found on curriculum page. Cookies may be valid but page structure changed.");
  }

  const columns = clusterByColumn(nodes);
  const currentTerm = config.studentMode === "regular"
    ? pickCurrentTermForRegular(columns)
    : null; // irregular not implemented yet

  if (!currentTerm) {
    throw new Error(
      `Could not determine current term for mode: ${config.studentMode}. ` +
      "Switch STUDENT_MODE or update term detection in src/htmlExtract.js."
    );
  }

  log(`[discover] Term column #${currentTerm.index + 1} with ${currentTerm.nodes.length} course(s).`);

  return {
    ...context,
    curriculum: { nodes, columns, currentTerm }
  };
}

function canSkip(context) {
  // Skip when caller has pre-populated curriculum (e.g., --use-saved path
  // doesn't need to scrape).
  return Boolean(context && context.curriculum);
}

module.exports = { name: "discover", run, canSkip };
