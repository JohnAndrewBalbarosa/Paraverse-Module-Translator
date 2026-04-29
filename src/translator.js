const { TranslatorClient } = require("./translatorClient");
const { translatePageObject, tryParseJsonObject } = require("./pageObjectTranslator");

class Translator extends TranslatorClient {
  tryParseJsonObject(raw) {
    return tryParseJsonObject(raw);
  }

  async translatePageObject(pageObject) {
    return translatePageObject(pageObject, this);
  }
}

module.exports = { Translator };
