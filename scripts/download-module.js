/**
 * Standalone runner: follows the recorded UI flow for a single course,
 * captures every PDF that the PDF Viewer loads, and saves them to
 * output/<course>/pdf/<module>.pdf — no Print dialog, no manual Save.
 *
 * Usage:
 *   node scripts/download-module.js "GED GED0085  ACTIVE"
 *   node scripts/download-module.js "GED GED0085  ACTIVE" "https://paraverse.feutech.edu.ph/network-map/curriculum"
 */

const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { chromium } = require("playwright");
const { capturePdfToFile } = require("../src/pdfCapture");

async function ensureLoggedIn(page, targetUrl) {
  const onParaverse = () => /paraverse\.feutech\.edu\.ph/.test(page.url());
  const onLogin = () =>
    /login\.microsoftonline\.com|login\.live\.com/i.test(page.url());

  // Try a quick auto-wait — SSO often completes on its own.
  if (!onParaverse()) {
    try {
      await page.waitForURL(/paraverse\.feutech\.edu\.ph/, { timeout: 15000 });
    } catch {
      /* fall through to manual prompt */
    }
  }

  if (onLogin() || !onParaverse()) {
    console.log("\n[download] Login required. Complete the login in the opened browser window.");
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      await rl.question("[download] When fully logged in (curriculum page is visible), type 'done' and press Enter: ");
    } finally {
      rl.close();
    }

    await page.waitForURL(/paraverse\.feutech\.edu\.ph/, { timeout: 0 });
    await page.waitForLoadState("domcontentloaded");
  }

  // Land on the requested page once logged in.
  if (page.url() !== targetUrl) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
}

function slug(s) {
  return (s || "module")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 100) || "module";
}

async function main() {
  const courseButtonName = process.argv[2] || "GED GED0085  ACTIVE";
  const startUrl =
    process.argv[3] || "https://paraverse.feutech.edu.ph/network-map/curriculum";

  const profileDir = path.resolve(process.cwd(), "sessions", "profile");
  const courseSlug = slug(courseButtonName.replace(/\s+ACTIVE$/i, ""));
  const outDir = path.resolve(process.cwd(), "output", courseSlug, "pdf");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[download] Course: ${courseButtonName}`);
  console.log(`[download] Output: ${outDir}\n`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1366, height: 900 }
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

    // Wait for Microsoft SSO to complete (auto or manual).
    await ensureLoggedIn(page, startUrl);

    // 1. Open course (long timeout — curriculum graph can be slow to render).
    await page
      .getByRole("button", { name: courseButtonName })
      .click({ timeout: 60000 });

    // 2. Access Map
    await page.getByRole("link", { name: "Access Map" }).click();

    // 3. Find every module list item that has a "Module N:" title
    await page.waitForSelector("role=listitem", { timeout: 15000 });
    const moduleTitles = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll("[role='listitem'], li"));
      const titles = new Set();
      for (const el of items) {
        const text = (el.textContent || "").trim();
        const match = text.match(/Module\s+\d+:[^\n\r]*/i);
        if (match) {
          titles.add(match[0].trim().slice(0, 200));
        }
      }
      return Array.from(titles);
    });

    console.log(`[download] Found ${moduleTitles.length} module(s):`);
    for (const t of moduleTitles) {
      console.log(`  - ${t}`);
    }
    console.log("");

    for (const moduleTitle of moduleTitles) {
      const safeTitle = slug(moduleTitle);
      const outFile = path.join(outDir, `${safeTitle}.pdf`);

      if (fs.existsSync(outFile)) {
        console.log(`[download] SKIP (exists): ${outFile}`);
        continue;
      }

      console.log(`[download] -> ${moduleTitle}`);

      try {
        // Expand module list item; sometimes needs a second click.
        const item = page
          .getByRole("listitem")
          .filter({ hasText: moduleTitle })
          .first();

        await item.getByRole("link").first().click().catch(() => {});
        await page.waitForTimeout(400);

        // Trigger Load Presentation while listening for the PDF response.
        const loadBtn = page.getByTitle("Load Presentation").first();
        await loadBtn.waitFor({ state: "visible", timeout: 15000 });

        const result = await capturePdfToFile(
          page,
          () => loadBtn.click(),
          outFile,
          { timeoutMs: 60000 }
        );

        console.log(
          `[download]    saved: ${path.basename(result.filePath)} (${result.bytes} bytes)`
        );
        console.log(`[download]    src:   ${result.url}`);

        // Go back to module map for next module.
        const backBtn = page
          .getByRole("button")
          .filter({ hasText: "Back to Map" })
          .first();
        if (await backBtn.isVisible().catch(() => false)) {
          await backBtn.click();
          await page.waitForTimeout(500);
        }
      } catch (err) {
        console.warn(`[download]    FAILED: ${err.message}`);
      }
    }
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
