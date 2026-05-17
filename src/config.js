const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function toBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).toLowerCase() === "true";
}

module.exports = {
  curriculumUrl: process.env.CURRICULUM_URL || "https://paraverse.feutech.edu.ph/network-map/curriculum/",
  curriculumCode: process.env.CURRICULUM_CODE || "",
  targetLanguage: process.env.TARGET_LANGUAGE || "",
  translationStyle: process.env.TRANSLATION_STYLE || "",
  studentMode: process.env.STUDENT_MODE || "regular",
  // Translator backend selector: "manual" (Claude/human writes JSONs),
  // "gemini" (Google Gemini API), or "identity" (passthrough/no-op).
  // If unset, defaults to manual when no API key is configured, else gemini.
  translator: process.env.TRANSLATOR || "",
  researchProvider: process.env.RESEARCH_PROVIDER || (process.env.RESEARCH_API_KEY ? "openai" : ""),
  researchApiKey: process.env.RESEARCH_API_KEY || process.env.OPENAI_API_KEY || "",
  // Leave empty when not set so translatorClient can pick the right default per
  // provider (Gemini -> generativelanguage.googleapis.com, OpenAI -> api.openai.com).
  // Hardcoding api.openai.com here previously sent Gemini API keys to OpenAI.
  researchBaseUrl: process.env.RESEARCH_BASE_URL || process.env.OPENAI_BASE_URL || "",
  researchModel: process.env.RESEARCH_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  headless: toBool(process.env.HEADLESS, false),
  outputDir: path.resolve(process.cwd(), "output"),
  sessionDir: path.resolve(process.cwd(), "sessions"),
  storageStatePath: path.resolve(process.cwd(), "sessions", "paraverse-session.json")
};
