const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const PptxGenJS = require("pptxgenjs");

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeFilePart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 100) || "module";
}

function extractSourceAssetUrl(moduleHref) {
  if (!moduleHref) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(moduleHref);
  } catch {
    return "";
  }

  const path = parsed.pathname.toLowerCase();
  if (path.includes("/assets/library/pdfjs/web/viewer.html")) {
    const fileParam = parsed.searchParams.get("file") || "";
    if (!fileParam) {
      return "";
    }

    try {
      return new URL(fileParam, `${parsed.origin}/`).href;
    } catch {
      return "";
    }
  }

  if (/\.(pdf|ppt|pptx)(\?|$)/i.test(moduleHref)) {
    return moduleHref;
  }

  return "";
}

function detectAssetType(assetUrl) {
  if (!assetUrl) {
    return "unknown";
  }

  const lower = assetUrl.toLowerCase();
  if (/\.pdf(\?|$)/i.test(lower)) {
    return "pdf";
  }
  if (/\.pptx(\?|$)/i.test(lower)) {
    return "pptx";
  }
  if (/\.ppt(\?|$)/i.test(lower)) {
    return "ppt";
  }
  return "unknown";
}

async function downloadBinary(requestContext, assetUrl) {
  if (!requestContext) {
    throw new Error("Missing authenticated request context.");
  }

  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await requestContext.get(assetUrl, { timeout: 60000 });
      if (!response.ok()) {
        throw new Error(`Failed to download asset (${response.status()}): ${assetUrl}`);
      }
      return response.body();
    } catch (err) {
      lastErr = err;
      const transient = /socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(err.message || "");
      if (attempt < MAX_ATTEMPTS && transient) {
        const backoffMs = 1000 * attempt;
        // eslint-disable-next-line no-console
        console.warn(`  [retry ${attempt}/${MAX_ATTEMPTS - 1}] ${err.message} -> waiting ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function cacheAsset(requestContext, assetUrl, cacheFilePath) {
  ensureDir(path.dirname(cacheFilePath));

  if (fs.existsSync(cacheFilePath)) {
    return {
      cacheHit: true,
      filePath: cacheFilePath,
      binary: fs.readFileSync(cacheFilePath)
    };
  }

  const binary = await downloadBinary(requestContext, assetUrl);
  fs.writeFileSync(cacheFilePath, binary);
  return {
    cacheHit: false,
    filePath: cacheFilePath,
    binary
  };
}

async function extractPdfPagesText(pdfBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer, disableWorker: true });
  const doc = await loadingTask.promise;
  const pages = [];

  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = normalizeText(content.items.map((item) => item.str || "").join(" "));
    pages.push({ page: i, sourceText: text });
  }

  return pages;
}

function buildPageObject(pages, keyName = "sourceText") {
  const pageObject = {};
  for (const page of pages) {
    pageObject[`PAGE ${page.page}`] = normalizeText(page[keyName] || "");
  }
  return pageObject;
}

function buildTranslatedPagesFromObject(sourcePages, translatedPageObject) {
  return sourcePages.map((page) => {
    const key = `PAGE ${page.page}`;
    return {
      page: page.page,
      sourceText: page.sourceText,
      translatedText: normalizeText(translatedPageObject?.[key] || page.sourceText)
    };
  });
}

async function generateTranslatedPptFromPdf(options) {
  const {
    requestContext,
    moduleHref,
    moduleTitle,
    moduleKey,
    cacheFileBasePath,
    outputPptxPath,
    translator,
    logger
  } = options;

  const assetUrl = extractSourceAssetUrl(moduleHref);
  if (!assetUrl) {
    return { generated: false, reason: "module-no-asset-url" };
  }

  const assetType = detectAssetType(assetUrl);
  const modulePart = safeFilePart(moduleKey || moduleTitle || "module");
  if (!cacheFileBasePath) {
    throw new Error(`Missing cacheFileBasePath for module: ${modulePart}`);
  }
  const cacheExt = assetType === "pdf" ? "pdf" : assetType === "pptx" ? "pptx" : assetType === "ppt" ? "ppt" : "bin";
  const cacheFilePath = `${cacheFileBasePath}.${cacheExt}`;

  logger?.(`Caching module asset: ${moduleTitle || moduleKey}`);
  const cached = await cacheAsset(requestContext, assetUrl, cacheFilePath);

  if (assetType !== "pdf") {
    return {
      generated: false,
      reason: "asset-not-supported-for-text-extraction",
      assetType,
      sourceAssetUrl: assetUrl,
      cacheFilePath,
      cacheHit: cached.cacheHit
    };
  }

  const pages = await extractPdfPagesText(cached.binary);
  const sourcePageObject = buildPageObject(pages, "sourceText");

  logger?.(`Sending per-page payload to translator: ${moduleTitle || moduleKey}`);
  let translatedPageObject = sourcePageObject;
  if (translator?.canTranslate()) {
    translatedPageObject = await translator.translatePageObject(sourcePageObject);
  }

  const translatedPages = buildTranslatedPagesFromObject(pages, translatedPageObject);

  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Paraverse Module Translator";
  pptx.subject = moduleTitle || "Module";
  pptx.title = moduleTitle || "Translated Module";

  for (const page of translatedPages) {
    const slide = pptx.addSlide();
    const header = `${moduleTitle || "Module"} - Page ${page.page}`;
    const body = page.translatedText || "(No extractable text found on this PDF page.)";

    slide.addText(header, {
      x: 0.4,
      y: 0.2,
      w: 12.4,
      h: 0.5,
      bold: true,
      fontSize: 18,
      color: "1F2937"
    });

    slide.addText(body, {
      x: 0.4,
      y: 0.9,
      w: 12.4,
      h: 6.0,
      fontSize: 16,
      color: "111827",
      valign: "top",
      fit: "shrink"
    });
  }

  await pptx.writeFile({ fileName: outputPptxPath });

  return {
    generated: true,
    sourceAssetUrl: assetUrl,
    cacheFilePath,
    cacheHit: cached.cacheHit,
    pageCount: translatedPages.length,
    pages: translatedPages,
    sourcePageObject,
    translatedPageObject
  };
}

module.exports = {
  extractSourceAssetUrl,
  generateTranslatedPptFromPdf,
  cacheAsset,
  detectAssetType
};
