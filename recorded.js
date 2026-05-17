const path = require("node:path");
const { chromium } = require("playwright");

(async () => {
  const profileDir = path.resolve(process.cwd(), "sessions", "profile");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    // viewport: null -> Playwright will not enforce a fixed viewport,
    // so the page surface follows the actual OS window size.
    viewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = context.pages()[0] || (await context.newPage());

  // Bind viewport to the window: re-sync whenever the OS window is resized.
  await bindViewportToWindow(page);

  // Auth + paraverse pages are slow — give them headroom.
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(120_000);

  await page.goto(
    "https://login.microsoftonline.com/b0a025d9-cb88-4408-9b15-ce77d47c3810/oauth2/v2.0/authorize" +
      "?client_id=d3fce7c5-4430-491c-b466-9511ff582f4d" +
      "&response_type=code" +
      "&redirect_uri=https%3A%2F%2Fparaverse.feutech.edu.ph%2Fapi%2Fv1%2Faccount%2Flogin-checkpoint" +
      "&response_mode=query" +
      "&scope=offline_access+user.read+mail.read+Calendars.Read" +
      "&state=%252Fnetwork-map%252Fcurriculum" +
      "&sso_reload=true"
  );

  // Account picker — only click if shown (skipped on already-signed-in sessions).
  const accountTile = page.locator('[data-test-id="jbalbarosa@fit.edu.ph"]');
  if (await accountTile.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await accountTile.click();
  }

  // MFA "Approve" prompt is handled on the user's phone — nothing to click in
  // the browser. Just wait for the redirect back to paraverse (up to 5 mins).
  console.log("[auth] waiting for MFA approval / redirect to paraverse...");
  await page.waitForURL(/paraverse\.feutech\.edu\.ph/, { timeout: 5 * 60_000 });

  await page.goto("https://paraverse.feutech.edu.ph/network-map/curriculum");
  await page.waitForLoadState("domcontentloaded");

  // Use a regex to tolerate stray unicode whitespace in the button label.
  await page.getByRole("button", { name: /GED\s*GED0085[\s\S]*ACTIVE/i }).click();
  await page.getByRole("link", { name: "Access Map" }).click();

  const mod1 = page
    .getByRole("listitem")
    .filter({ hasText: "Module 1: Introduction to the" });
  await mod1.getByRole("link").first().click();

  await page.locator(".border-start.border-active").first().click();
  await page.getByTitle("Load Presentation").first().click();

  const pdfFrame = page.locator('iframe[title="PDF Viewer"]').contentFrame();
  await pdfFrame.locator("#scaleSelect").selectOption("page-fit");
  await pdfFrame.getByRole("button", { name: "Print" }).click();

  console.log("[done] script finished — close the window to exit.");
  await page.waitForEvent("close", { timeout: 0 });

  await context.close();
})();

/**
 * Make the Playwright page viewport track the real browser window size.
 *
 * Playwright defaults to a fixed emulated viewport that is decoupled from the
 * OS window. Passing `viewport: null` at launch lets the page use the real
 * window size, but Playwright still won't react to window resizes on its own.
 * This helper listens to the page's `resize` event (plus visualViewport for
 * zoom) and polls every 500ms, then pushes the new inner dimensions back into
 * Playwright via `setViewportSize` so screenshots, hit-testing, and
 * `page.viewportSize()` stay in sync.
 *
 * @param {import('playwright').Page} page
 */
async function bindViewportToWindow(page) {
  let last = { width: 0, height: 0 };
  let syncing = false;
  let closed = false;

  const sync = async () => {
    if (closed || syncing) return;
    syncing = true;
    try {
      const size = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight
      }));
      // Only push to Playwright when the size actually changed. Calling
      // setViewportSize() unconditionally in headed mode shrinks the OS
      // window and creates a feedback loop.
      if (
        size.width > 0 &&
        size.height > 0 &&
        (size.width !== last.width || size.height !== last.height)
      ) {
        last = size;
        await page.setViewportSize(size);
      }
    } catch {
      // Page may be navigating, zooming, or closed; ignore transient errors.
    } finally {
      syncing = false;
    }
  };

  await page.exposeFunction("__notifyViewportResize", sync);

  const install = async () => {
    try {
      await page.evaluate(() => {
        if (window.__viewportBound) return;
        window.__viewportBound = true;
        let t;
        const ping = () => {
          clearTimeout(t);
          t = setTimeout(() => window.__notifyViewportResize(), 150);
        };
        window.addEventListener("resize", ping);
      });
    } catch {
      // Page may not be ready yet.
    }
  };

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) install();
  });
  page.on("close", () => {
    closed = true;
  });

  // One-shot initial alignment, then react only to real resize events.
  await install();
  await sync();
}
