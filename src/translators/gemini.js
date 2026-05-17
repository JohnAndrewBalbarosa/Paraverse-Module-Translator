/**
 * Gemini translator — uses Google's Gemini API via the OpenAI-compatible
 * endpoint. Reuses TranslatorClient from src/translatorClient.js (which already
 * routes Gemini correctly when researchProvider="gemini").
 *
 * Sends the compact pages JSON as a single prompt and asks the model to
 * return the same shape with translated string values. Falls back to per-page
 * translation when whole-document translation fails or model returns invalid
 * structure.
 */

const { TranslatorClient } = require("../translatorClient");

const SYSTEM_PROMPT =
  "You are a precise translator working on academic course material. " +
  "You translate the string VALUES of the input JSON to the requested " +
  "target language, while keeping JSON keys, structure, and order " +
  "completely identical. Never add, remove, or reorder fields. Preserve " +
  "code, equations, proper nouns, and acronyms verbatim.";

function buildUserPrompt(sourceJson, targetLang) {
  return [
    `Translate every "h" (heading) and "p" (paragraph) string value in the`,
    `JSON below to ${targetLang}.`,
    `Schema: pages[].lines[] is an array of {"h": "..."} or {"p": "..."} items.`,
    `Replace only the string values. Keep keys, structure, and order identical.`,
    `Return ONLY the JSON, no markdown fences, no commentary.`,
    ``,
    JSON.stringify({ pages: sourceJson.pages }, null, 1)
  ].join("\n");
}

function tryParseModelOutput(raw) {
  if (!raw) return null;
  // Strip optional ```json fences
  const cleaned = String(raw)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last-ditch: extract first {...} block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function validateShape(translated, source) {
  if (!translated || !Array.isArray(translated.pages)) return false;
  if (translated.pages.length !== source.pages.length) return false;
  for (let i = 0; i < translated.pages.length; i += 1) {
    const a = translated.pages[i];
    const b = source.pages[i];
    if (!a || !Array.isArray(a.lines) || a.lines.length !== b.lines.length) return false;
    for (let j = 0; j < a.lines.length; j += 1) {
      const lineA = a.lines[j];
      const lineB = b.lines[j];
      // Each line must have the same key (h or p)
      const keyA = Object.keys(lineA || {})[0];
      const keyB = Object.keys(lineB || {})[0];
      if (keyA !== keyB) return false;
    }
  }
  return true;
}

function create(deps = {}) {
  const { config } = deps;
  if (!config) {
    throw new Error("gemini translator requires { config } in deps");
  }
  const client = new TranslatorClient({
    targetLanguage: config.targetLang || "tl",
    style: config.translationStyle || "",
    researchProvider: config.researchProvider || "gemini",
    researchApiKey: config.researchApiKey,
    researchBaseUrl: config.researchBaseUrl,
    researchModel: config.researchModel,
    disableCache: true
  });

  return {
    name: "gemini",
    canTranslate() {
      return client.canTranslate();
    },
    async translatePagesJson(sourceJson, opts) {
      const targetLang = (opts && opts.targetLang) || config.targetLang || "tl";
      if (!client.canTranslate()) {
        return { status: "failed", reason: "no API key configured" };
      }

      let raw;
      try {
        raw = await client.sendMessages(
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(sourceJson, targetLang) }
          ],
          0.2
        );
      } catch (err) {
        return { status: "failed", reason: `API call failed: ${err.message}` };
      }

      const parsed = tryParseModelOutput(raw);
      if (!parsed) {
        return { status: "failed", reason: "model output was not valid JSON" };
      }
      if (!validateShape(parsed, sourceJson)) {
        return { status: "failed", reason: "model output did not match source structure" };
      }

      // Build translated JSON preserving meta but updating translation fields.
      const translatedJson = {
        meta: {
          ...sourceJson.meta,
          targetLang,
          translator: "gemini",
          translatedAt: new Date().toISOString()
        },
        pages: parsed.pages
      };
      return { status: "translated", translatedJson };
    }
  };
}

module.exports = { create };
