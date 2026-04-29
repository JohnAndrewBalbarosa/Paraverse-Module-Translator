const fetch = require("node-fetch");

class TranslatorClient {
  constructor(options) {
    this.targetLanguage = options.targetLanguage;
    this.style = options.style;
    this.researchProvider = options.researchProvider || "openai";
    this.researchApiKey = options.researchApiKey;
    this.researchBaseUrl = options.researchBaseUrl;
    this.researchModel = options.researchModel;
    this.disableCache = Boolean(options.disableCache);
    this.cache = new Map();
  }

  canTranslate() {
    return Boolean(this.researchApiKey);
  }

  getChatCompletionsUrl() {
    if (this.researchProvider.toLowerCase() === "gemini") {
      const base = (this.researchBaseUrl || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, "");
      return `${base}/chat/completions`;
    }
    const base = (this.researchBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    return `${base}/chat/completions`;
  }

  async sendMessages(messages, temperature = 0.2) {
    const response = await fetch(this.getChatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.researchApiKey}`
      },
      body: JSON.stringify({
        model: this.researchModel,
        temperature,
        messages
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Translation API failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async translateViaProvider(text) {
    const targetLanguage = this.targetLanguage || "Taglish";
    const prompt = [
      "You translate educational module text.",
      `Target language: ${targetLanguage}.`,
      "Preserve meaning and classroom tone.",
      "Return only the translated text, no extra notes.",
      `Text: ${text}`
    ].join("\n");

    return this.sendMessages(
      [
        { role: "system", content: "You are a precise translator." },
        { role: "user", content: prompt }
      ],
      0.2
    );
  }

  async translateText(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return text;
    if (!this.canTranslate()) return text;
    if (!this.disableCache && this.cache.has(trimmed)) return this.cache.get(trimmed);

    const translated = await this.translateViaProvider(trimmed);
    if (!this.disableCache) this.cache.set(trimmed, translated);
    return translated;
  }
}

function createTranslatorClient(options) {
  return new TranslatorClient(options);
}

module.exports = { TranslatorClient, createTranslatorClient };
