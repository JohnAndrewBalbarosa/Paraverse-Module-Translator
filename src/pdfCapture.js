const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isPdfResponse(resp) {
  const contentType = (resp.headers()["content-type"] || "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    return true;
  }
  const url = resp.url();
  return /\.pdf(\?|$|#)/i.test(url);
}

/**
 * Listens for the next PDF response on a page (and any of its frames) and
 * resolves with { url, buffer } when one arrives. Times out after `timeoutMs`.
 *
 * Use this BEFORE triggering the click that loads the PDF viewer.
 */
function awaitNextPdfResponse(page, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off("response", onResponse);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for a PDF response`));
    }, timeoutMs);

    async function onResponse(resp) {
      if (!isPdfResponse(resp)) {
        return;
      }
      page.off("response", onResponse);
      clearTimeout(timer);
      try {
        const buffer = await resp.body();
        resolve({ url: resp.url(), buffer });
      } catch (err) {
        reject(err);
      }
    }

    page.on("response", onResponse);
  });
}

/**
 * Triggers `triggerFn` (e.g. clicking "Load Presentation") and captures the
 * resulting PDF, saving it to `outFile`. Returns metadata.
 */
async function capturePdfToFile(page, triggerFn, outFile, options = {}) {
  ensureDir(path.dirname(outFile));

  const responsePromise = awaitNextPdfResponse(page, options);
  await triggerFn();
  const { url, buffer } = await responsePromise;

  fs.writeFileSync(outFile, buffer);
  return { url, filePath: outFile, bytes: buffer.length };
}

module.exports = {
  isPdfResponse,
  awaitNextPdfResponse,
  capturePdfToFile
};
