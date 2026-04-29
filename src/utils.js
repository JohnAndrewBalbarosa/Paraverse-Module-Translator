const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeFileName(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 120) || "untitled";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinOutputPath(baseDir, ...parts) {
  return path.join(baseDir, ...parts.map((p) => safeFileName(p)));
}

function writeModuleJson(outputPath, meta, sourcePageObject, translatedPageObject) {
  const pages = {};
  for (const key of Object.keys(sourcePageObject)) {
    pages[key] = {
      original: sourcePageObject[key] || "",
      translated: (translatedPageObject && translatedPageObject[key]) || sourcePageObject[key] || ""
    };
  }

  const output = {
    meta: { ...meta, pageCount: Object.keys(pages).length },
    pages
  };

  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8");
}

module.exports = {
  ensureDir,
  safeFileName,
  delay,
  joinOutputPath,
  writeModuleJson
};
