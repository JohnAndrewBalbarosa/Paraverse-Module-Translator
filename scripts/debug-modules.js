const { chromium } = require("playwright");
const path = require("path");

const HOST = "paraverse.feutech.edu.ph";
const PROFILE_DIR = path.resolve(process.cwd(), "sessions", "profile");

// GED0085: course-id=520, module-ids from the HTML
const MODULES = [
  { moduleId: "3584", moduleNumber: "1" },
  { moduleId: "3585", moduleNumber: "2" },
  { moduleId: "3586", moduleNumber: "3" },
];

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  // Navigate to the course page first to establish correct session/cookies
  await page.goto(`https://${HOST}/network-map/course/GED0085&curriculum=`, { waitUntil: "domcontentloaded" });
  try { await page.waitForSelector(`li[data-course="GED0085"]`, { timeout: 30000 }); } catch {}

  // Get actual module IDs from the page DOM
  const realModules = await page.$$eval(`li[data-course="GED0085"]`, items =>
    items.slice(0, 3).map(li => ({
      moduleId: li.getAttribute("module-id"),
      moduleNumber: li.getAttribute("module-number"),
    }))
  );
  console.log("Real module IDs from DOM:", realModules);

  for (const mod of realModules) {
    const url = `https://${HOST}/network-map/includes/core-fetch-modules.php?course-id=520&module-id=${mod.moduleId}&course-status=active`;
    const res = await page.request.fetch(url, {
      headers: {
        "Referer": `https://${HOST}/network-map/course/GED0085&curriculum=`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const text = await res.text();

    // Find all endpoint-url values
    const endpoints = [...text.matchAll(/endpoint-url=["']([^"']+)["']/g)].map(m => m[1]);
    // Find all powerpoint PDF paths
    const pdfs = [...new Set([...text.matchAll(/\/network-map\/assets\/powerpoint\/[^"'\s<>]+\.pdf/g)].map(m => m[0]))];

    console.log(`\n=== M${mod.moduleNumber} (module-id=${mod.moduleId}) ===`);
    console.log(`  endpoint-url values: ${endpoints.length ? endpoints.join(" | ") : "(none)"}`);
    console.log(`  all PDF paths: ${pdfs.length ? pdfs.join(" | ") : "(none)"}`);
    console.log(`  response size: ${text.length} bytes`);
  }
  await ctx.close();
})();
