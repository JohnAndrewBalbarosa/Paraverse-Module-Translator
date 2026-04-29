const fs = require("fs");
const path = require("path");
const { ensureDir } = require("./utils");

async function observerMode(context, outputDir) {
  ensureDir(outputDir);

  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(outputDir, `observe-session-${sessionId}.json`);

  const events = [];

  function pushEvent(event) {
    events.push(event);
    fs.writeFileSync(logPath, JSON.stringify({ session: new Date().toISOString(), events }, null, 2), "utf8");
  }

  const page = await context.newPage();

  page.on("request", (request) => {
    pushEvent({
      type: "request",
      timestamp: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType()
    });
  });

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      pushEvent({
        type: "navigation",
        timestamp: new Date().toISOString(),
        url: frame.url()
      });
    }
  });

  // Inject a click-capture script on every page load.
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      (e) => {
        const el = e.target;
        const info = {
          tag: el.tagName,
          id: el.id || undefined,
          className: (el.className || "").slice(0, 120),
          text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
          href: el.href || undefined,
          dataAttrs: Object.fromEntries(
            [...el.attributes]
              .filter((a) => a.name.startsWith("data-") || a.name === "module-id" || a.name === "course-id")
              .map((a) => [a.name, a.value])
          )
        };
        console.log(`__OBSERVER_CLICK__${JSON.stringify(info)}`);
      },
      true
    );
  });

  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("__OBSERVER_CLICK__")) {
      try {
        const data = JSON.parse(text.slice("__OBSERVER_CLICK__".length));
        pushEvent({ type: "click", timestamp: new Date().toISOString(), element: data });
      } catch {
        // Ignore malformed click events.
      }
    }
  });

  await page.goto("https://paraverse.feutech.edu.ph/network-map/curriculum/", { waitUntil: "domcontentloaded" });

  console.log("=== Observer Mode ===");
  console.log(`Navigate the site normally. All requests and clicks are being logged.`);
  console.log(`Log file: ${logPath}`);
  console.log("Press Ctrl+C to stop.\n");

  // Keep running until the process is terminated.
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

  console.log(`\nObserver stopped. Session saved to: ${logPath}`);
  await page.close();
}

module.exports = { observerMode };
