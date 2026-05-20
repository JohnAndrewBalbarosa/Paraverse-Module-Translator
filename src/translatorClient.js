const fetch = require("node-fetch");

function sleepWithBackoff(attempt) {
  // Exponential backoff with full jitter: base * 2^(attempt-1) up to 30s,
  // jittered into [0, computed]. Smooths the thundering herd during outages.
  const base = 1000;
  const cap = 30000;
  const exp = Math.min(cap, base * Math.pow(2, attempt - 1));
  const wait = Math.floor(Math.random() * exp);
  return new Promise((resolve) => setTimeout(resolve, wait));
}

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
    // Retry transient upstream failures (Gemini and OpenAI both throw 429 on
    // rate-limit and 5xx during capacity spikes — neither indicates a payload
    // problem). Exponential backoff with jitter; cap at 5 attempts so one
    // hour-long Gemini outage doesn't burn the whole pipeline silently.
    const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
    const MAX_ATTEMPTS = 5;
    let attempt = 0;
    while (true) {
      attempt += 1;
      let response;
      try {
        response = await fetch(this.getChatCompletionsUrl(), {
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
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`Translation API network error after ${attempt} attempts: ${err.message}`);
        }
        await sleepWithBackoff(attempt);
        continue;
      }

      if (response.ok) {
        const data = await response.json();
        return data.choices?.[0]?.message?.content || "";
      }

      const body = await response.text();
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= MAX_ATTEMPTS) {
        throw new Error(`Translation API failed (${response.status}) after ${attempt} attempt(s): ${body.slice(0, 200)}`);
      }
      await sleepWithBackoff(attempt);
    }
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
