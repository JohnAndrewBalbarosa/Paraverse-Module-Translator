/**
 * Translator backend factory + interface.
 *
 * A translator is anything that satisfies:
 *
 *   interface Translator {
 *     name: string                                    // identifier for logs/meta
 *     canTranslate(): boolean                         // is this backend ready?
 *     async translatePagesJson(sourceJson, opts): {
 *       status: "translated" | "pending" | "skipped" | "failed",
 *       translatedJson?: object,    // present when status === "translated"
 *       reason?: string             // present when not translated
 *     }
 *   }
 *
 * Adding a new backend (e.g., Anthropic Claude API, DeepSeek):
 *   1. Create src/translators/<name>.js exporting a factory function
 *   2. Register it in BACKENDS below
 *   3. Document it in docs/translators.md
 *
 * No existing stages need to change. That's the decoupling promise.
 */

const gemini = require("./gemini");
const manual = require("./manual");
const identity = require("./identity");

const BACKENDS = {
  gemini: gemini.create,
  manual: manual.create,
  identity: identity.create
};

function pickDefaultBackend(config) {
  if (config && config.researchApiKey) return "gemini";
  return "manual";
}

function create(name, deps = {}) {
  const factory = BACKENDS[name];
  if (!factory) {
    const known = Object.keys(BACKENDS).join(", ");
    throw new Error(`Unknown translator backend "${name}". Known: ${known}`);
  }
  return factory(deps);
}

module.exports = {
  create,
  pickDefaultBackend,
  knownBackends: () => Object.keys(BACKENDS)
};
