function tryParseJsonObject(raw) {
  if (!raw) return null;

  const trimmed = String(raw).trim();

  const direct = (() => {
    try { return JSON.parse(trimmed); } catch { return null; }
  })();

  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeTranslatedPageObject(sourcePageObject, translatedCandidate) {
  const normalized = {};
  for (const key of Object.keys(sourcePageObject)) {
    normalized[key] = typeof translatedCandidate?.[key] === "string"
      ? translatedCandidate[key]
      : sourcePageObject[key];
  }
  return normalized;
}

async function translatePageObject(pageObject, translatorClient, options = {}) {
  if (!pageObject || typeof pageObject !== "object") return pageObject;

  const keys = Object.keys(pageObject);
  if (!keys.length || !translatorClient.canTranslate()) return pageObject;

  const targetLanguage = options.targetLanguage || translatorClient.targetLanguage || "Taglish";

  const promptPayload = {
    intent: "Translate each page of a module into the target language while preserving educational meaning and tone.",
    targetLanguage,
    instructions: [
      "Translate only the values for each PAGE key.",
      "Do not change PAGE keys.",
      "Preserve technical terms when needed for clarity.",
      "Return strict JSON only using the exact same PAGE keys as the input pages object.",
      "Your response must be directly usable as page replacements."
    ],
    pages: pageObject
  };

  const prompt = [
    "Translate the following structured JSON payload.",
    "Follow the intent and instructions exactly.",
    "Return strictly valid JSON object only, no markdown, no explanation.",
    JSON.stringify(promptPayload)
  ].join("\n");

  try {
    const content = await translatorClient.sendMessages(
      [
        { role: "system", content: "You are a precise translator that outputs strict JSON only." },
        { role: "user", content: prompt }
      ],
      0.1
    );

    const parsed = tryParseJsonObject(content);
    if (parsed) return normalizeTranslatedPageObject(pageObject, parsed);
  } catch {
    // Fall back to per-page translation below.
  }

  const fallback = {};
  for (const key of keys) {
    fallback[key] = await translatorClient.translateText(pageObject[key] || "");
  }
  return fallback;
}

module.exports = { translatePageObject, tryParseJsonObject, normalizeTranslatedPageObject };
