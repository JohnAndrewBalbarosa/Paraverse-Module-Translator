/**
 * Manual translator — for offline / human / external-AI translation.
 *
 * This backend does NOT call any API. It works on a "convention-over-API"
 * basis: the translate stage will write source JSONs (already present at
 * output/<course>/json/<base>.json), then check whether a translated sibling
 * exists at output/<course>/json/<base>.<lang>.json.
 *
 * - If the sibling exists, the file is considered "translated" by some
 *   external agent (could be a human, could be Claude reading these files in
 *   a side-channel, could be a script with its own LLM).
 * - If the sibling is missing, returns status="pending" so the pipeline can
 *   surface a TODO list to the user.
 *
 * Idempotent: re-running the stage picks up files that have appeared since.
 */

const fs = require("fs");
const path = require("path");

function buildTranslatedPath(sourcePath, targetLang) {
  // output/<course>/json/<base>.json  ->  output/<course>/json/<base>.<lang>.json
  const dir = path.dirname(sourcePath);
  const ext = path.extname(sourcePath); // ".json"
  const base = path.basename(sourcePath, ext); // "<base>"
  return path.join(dir, `${base}.${targetLang}${ext}`);
}

function create() {
  return {
    name: "manual",
    canTranslate() {
      // The manual backend never "fails" — it always reports either
      // translated or pending. Returning true means the translate stage
      // should bother invoking it.
      return true;
    },
    /**
     * @param {object} sourceJson  The source compact-v1 JSON. Must include
     *   sourceJson.meta.sourcePath (absolute path to the source file on disk)
     *   so we can compute where the translated sibling should be.
     * @param {object} opts
     * @param {string} opts.targetLang  e.g. "tl"
     */
    async translatePagesJson(sourceJson, opts) {
      const sourcePath = sourceJson && sourceJson.meta && sourceJson.meta.sourcePath;
      const targetLang = (opts && opts.targetLang) || "tl";
      if (!sourcePath) {
        return {
          status: "failed",
          reason: "manual translator requires meta.sourcePath in the source JSON"
        };
      }

      const expectedPath = buildTranslatedPath(sourcePath, targetLang);
      if (!fs.existsSync(expectedPath)) {
        return {
          status: "pending",
          reason: `awaiting external translation at ${expectedPath}`,
          expectedPath
        };
      }

      let translatedJson;
      try {
        translatedJson = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
      } catch (err) {
        return {
          status: "failed",
          reason: `translated file at ${expectedPath} is not valid JSON: ${err.message}`,
          expectedPath
        };
      }

      return {
        status: "translated",
        translatedJson,
        translatedPath: expectedPath
      };
    }
  };
}

module.exports = { create, buildTranslatedPath };
