/**
 * Stage: selectCourses
 *
 * Responsibilities:
 *   - Deduplicate the current-term courses
 *   - Either auto-pick all (when non-interactive) or prompt the user
 *
 * Reads from context:  curriculum.currentTerm, cliArgs.autoAll
 * Writes to context:   selectedCourses[]
 *
 * Skipped when:  selectedCourses already populated (e.g., --use-saved path)
 */

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");

function dedupe(courses) {
  const seen = new Set();
  const out = [];
  for (const c of courses) {
    const key = c.courseCode || c.href || c.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

async function promptUser(courses, log) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    log("\n=== Course Selection (Current Term) ===");
    for (let i = 0; i < courses.length; i += 1) {
      log(`${i + 1}) ${courses[i].title}`);
    }
    log("Type course numbers separated by comma (example: 1,3,5) or press Enter for all.");
    const answer = (await rl.question("Select courses: ")).trim();
    if (!answer) return courses;
    const picks = answer
      .split(",")
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((v) => !Number.isNaN(v) && v >= 1 && v <= courses.length);
    const unique = [...new Set(picks)];
    if (!unique.length) {
      log("No valid selection. Using all courses.");
      return courses;
    }
    return unique.map((idx) => courses[idx - 1]);
  } finally {
    rl.close();
  }
}

async function run(context, deps) {
  const log = (deps && deps.log) || (() => {});
  const courses = dedupe(context.curriculum.currentTerm.nodes);
  const auto = context.cliArgs && (context.cliArgs.autoAll || context.cliArgs.translateVerify);
  const selected = auto ? courses : await promptUser(courses, log);
  log(`[selectCourses] ${selected.length} course(s) selected`);
  return { ...context, selectedCourses: selected };
}

function canSkip(context) {
  return Boolean(context && context.selectedCourses && context.selectedCourses.length);
}

module.exports = { name: "selectCourses", run, canSkip };
