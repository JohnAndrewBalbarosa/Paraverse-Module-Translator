/**
 * Stage: translate
 *
 * Responsibilities:
 *   - For each extracted JSON, run the configured translator backend
 *   - Write translated output to <base>.<lang>.json next to source
 *   - Backend decides how (Gemini API, manual queue, identity passthrough)
 *
 * Reads from context:  extractedModules, translator, cliArgs.targetLang
 * Writes to context:   translatedModules[] = [{ course, modules[] with translatedPath, status }]
 *
 * Skipped when:  cliArgs.translate is false (translation is opt-in)
 *
 * Status values per module:
 *   - "translated"  — translatedPath written by backend
 *   - "pending"     — manual backend, awaiting external translation
 *   - "skipped"     — identity backend or already up to date
 *   - "failed"      — backend reported error; reason in .reason
 *   - "no-source"   — module never had a JSON to translate
 */

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("../utils");

function loadSourceJson(jsonPath) {
  const raw = fs.readFileSync(jsonPath, "utf8");
  const parsed = JSON.parse(raw);
  // Inject absolute path so the manual backend can compute sibling path.
  if (!parsed.meta) parsed.meta = {};
  parsed.meta.sourcePath = jsonPath;
  return parsed;
}

function buildTranslatedPath(sourcePath, targetLang) {
  const dir = path.dirname(sourcePath);
  const ext = path.extname(sourcePath);
  const base = path.basename(sourcePath, ext);
  return path.join(dir, `${base}.${targetLang}${ext}`);
}

async function run(context, deps) {
  const { extractedModules, translator, cliArgs } = context;
  const log = (deps && deps.log) || (() => {});
  const targetLang = (cliArgs && cliArgs.targetLang) || "tl";

  if (!translator) {
    throw new Error("translate stage requires context.translator (set by pipeline runner)");
  }

  log(`[translate] backend=${translator.name}  targetLang=${targetLang}`);
  const translatedModules = [];
  const pendingForBackend = [];

  for (const entry of extractedModules) {
    const out = [];
    log(`[translate] === ${entry.course.title} ===`);
    for (let i = 0; i < entry.modules.length; i += 1) {
      const m = entry.modules[i];
      if (!m.jsonPath) {
        out.push({ ...m, translatedPath: "", translateStatus: "no-source" });
        continue;
      }

      const expectedPath = buildTranslatedPath(m.jsonPath, targetLang);

      // Short-circuit if the translated sibling already exists. Lets re-runs
      // be cheap and lets the manual workflow be resumable.
      if (fs.existsSync(expectedPath)) {
        out.push({
          ...m,
          translatedPath: expectedPath,
          translateStatus: "translated",
          translateReason: "already on disk"
        });
        log(`[translate]   ${i + 1}/${entry.modules.length} (cached) ${path.basename(expectedPath)}`);
        continue;
      }

      let sourceJson;
      try {
        sourceJson = loadSourceJson(m.jsonPath);
      } catch (err) {
        out.push({ ...m, translatedPath: "", translateStatus: "failed", translateReason: `source unreadable: ${err.message}` });
        continue;
      }

      let result;
      try {
        result = await translator.translatePagesJson(sourceJson, { targetLang });
      } catch (err) {
        result = { status: "failed", reason: err.message };
      }

      if (result.status === "translated" && result.translatedJson) {
        ensureDir(path.dirname(expectedPath));
        fs.writeFileSync(expectedPath, JSON.stringify(result.translatedJson, null, 1), "utf8");
        out.push({
          ...m,
          translatedPath: expectedPath,
          translateStatus: "translated"
        });
        log(`[translate]   ${i + 1}/${entry.modules.length} OK ${path.basename(expectedPath)}`);
      } else if (result.status === "pending") {
        pendingForBackend.push({
          course: entry.course.title,
          module: m.title,
          sourcePath: m.jsonPath,
          expectedPath
        });
        out.push({
          ...m,
          translatedPath: "",
          translateStatus: "pending",
          translateReason: result.reason || "awaiting external translation"
        });
      } else if (result.status === "skipped") {
        out.push({
          ...m,
          translatedPath: "",
          translateStatus: "skipped",
          translateReason: result.reason || "translator chose to skip"
        });
      } else {
        out.push({
          ...m,
          translatedPath: "",
          translateStatus: "failed",
          translateReason: result.reason || "unknown failure"
        });
        log(`[translate]   ${i + 1}/${entry.modules.length} FAILED ${m.fileBase}: ${result.reason}`);
      }
    }
    translatedModules.push({
      course: entry.course,
      courseFolder: entry.courseFolder,
      modules: out
    });
  }

  if (pendingForBackend.length > 0) {
    log(`\n[translate] >>> ${pendingForBackend.length} file(s) pending external translation (backend=${translator.name}) <<<`);
    log(`[translate] Instructions:`);
    log(`[translate]   For each source file, produce a translated copy at the listed`);
    log(`[translate]   expected path. Keep the JSON structure identical; replace only`);
    log(`[translate]   the values of "h" (heading) and "p" (paragraph) fields with`);
    log(`[translate]   ${targetLang} translations.`);
    log(`[translate] Pending files:`);
    for (const p of pendingForBackend) {
      log(`[translate]   - ${path.relative(process.cwd(), p.sourcePath)}`);
      log(`[translate]       -> ${path.relative(process.cwd(), p.expectedPath)}`);
    }
    log(`[translate] After translations are written, re-run with the same arguments to pick them up.`);
  }

  return { ...context, translatedModules, translatePending: pendingForBackend };
}

function canSkip(context) {
  return !(context && context.cliArgs && context.cliArgs.translate);
}

module.exports = { name: "translate", run, canSkip, buildTranslatedPath };
