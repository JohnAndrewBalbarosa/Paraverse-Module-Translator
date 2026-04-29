const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { ensureDir, safeFileName, delay, writeModuleJson } = require("./utils");
const { translateHtmlPreservingMarkup, buildPageObjectFromHtml } = require("./htmlTranslate");
const { translatePageObject } = require("./pageObjectTranslator");
const { generateTranslatedPptFromPdf, extractSourceAssetUrl } = require("./pdfPptTranslate");

function buildCourseMapUrl(curriculumUrl, courseCode, curriculumCode) {
  if (!courseCode) {
    return "";
  }

  let origin = "https://paraverse.feutech.edu.ph";
  try {
    origin = new URL(curriculumUrl).origin;
  } catch {
    // Keep default origin when CURRICULUM_URL is malformed.
  }

  return `${origin}/network-map/course/${encodeURIComponent(courseCode)}&curriculum=${encodeURIComponent(curriculumCode || "")}`;
}

function getCourseCodeFromText(text) {
  const raw = String(text || "").toUpperCase();
  const match = raw.match(/\b([A-Z]{2,}\d{3,}[A-Z]?)\b/);
  return match ? match[1] : "";
}

function buildModuleStubHtml(courseTitle, moduleTitle, moduleHref) {
  const safeTitle = moduleTitle || "Module";
  const safeCourse = courseTitle || "Course";
  if (!moduleHref) {
    return `<!doctype html><html><head><meta charset=\"utf-8\"><title>${safeTitle}</title></head><body><h1>${safeCourse}</h1><h2>${safeTitle}</h2><p>No direct module file URL was exposed by the page for this module.</p></body></html>`;
  }

  return `<!doctype html><html><head><meta charset=\"utf-8\"><title>${safeTitle}</title></head><body><h1>${safeCourse}</h1><h2>${safeTitle}</h2><p>Source file:</p><p><a href=\"${moduleHref}\">${moduleHref}</a></p></body></html>`;
}

async function launchContext(config) {
  ensureDir(path.dirname(config.storageStatePath));

  const context = await chromium.launchPersistentContext(path.join(config.sessionDir, "profile"), {
    headless: config.headless,
    viewport: { width: 1366, height: 900 }
  });

  return context;
}

async function waitForLogin(page) {
  await page.goto("https://paraverse.feutech.edu.ph/network-map/curriculum/", { waitUntil: "domcontentloaded" });

  // During SSO redirects, the page execution context can be replaced quickly.
  // URL-based detection is more stable than evaluating page DOM at this stage.
  let loginLikely = /login\.microsoftonline\.com/i.test(page.url());
  if (!loginLikely) {
    try {
      const text = await page.locator("body").innerText({ timeout: 1500 });
      loginLikely = /sign in|microsoft|login/i.test(text);
    } catch {
      loginLikely = /login\.microsoftonline\.com/i.test(page.url());
    }
  }

  if (loginLikely) {
    console.log("Login required. Please complete login in the opened browser window.");

    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      await rl.question("When you are fully logged in, type done and press Enter: ");
    } finally {
      rl.close();
    }

    await page.waitForURL(/paraverse\.feutech\.edu\.ph/, { timeout: 0 });
    await page.waitForLoadState("domcontentloaded");
    await delay(2000);
  }
}

async function extractCourseNodes(page) {
  return page.evaluate(() => {
    function detectStatus(el) {
      const cls = (el.className || "").toString().toLowerCase();
      const text = (el.innerText || "").toLowerCase();
      if (/passed|complete|completed/.test(cls) || /passed|completed/.test(text)) {
        return "passed";
      }
      if (/pending|ongoing|current|in-progress/.test(cls) || /pending|ongoing|current/.test(text)) {
        return "pending";
      }
      if (/locked/.test(cls) || /locked/.test(text)) {
        return "locked";
      }
      return "unknown";
    }

    function getCourseCode(text) {
      const raw = (text || "").toUpperCase();
      const match = raw.match(/\b([A-Z]{2,}\d{3,}[A-Z]?)\b/);
      return match ? match[1] : "";
    }

    const buttonNodes = Array.from(document.querySelectorAll("table tbody button")).map((btn) => {
      const text = (btn.textContent || "").trim().replace(/\s+/g, " ");
      const rect = btn.getBoundingClientRect();
      const code = getCourseCode(text);
      const dept = (text.split(" ")[0] || "").toUpperCase();
      const title = code ? `${dept} ${code}`.trim() : text;
      return {
        href: "",
        courseCode: code,
        title,
        x: rect.left,
        y: rect.top,
        status: detectStatus(btn)
      };
    });

    const cleanButtons = buttonNodes.filter((n) => n.courseCode && n.title);
    if (cleanButtons.length) {
      return cleanButtons;
    }

    // Fallback for legacy layouts that used direct anchors.
    const anchors = Array.from(document.querySelectorAll("a[href*='/network-map/course/']"));
    const nodes = anchors.map((a) => {
      const card = a.closest(".node, .course, .card") || a.parentElement || a;
      const rect = card.getBoundingClientRect();
      const title = (a.textContent || card.textContent || "").trim().replace(/\s+/g, " ");
      const code = getCourseCode(title);
      return {
        href: a.href,
        courseCode: code,
        title,
        x: rect.left,
        y: rect.top,
        status: detectStatus(card)
      };
    });

    return nodes.filter((n) => (n.href || n.courseCode) && n.title);
  });
}

function clusterByColumn(nodes) {
  const sorted = [...nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  const columns = [];

  for (const node of sorted) {
    const existing = columns.find((col) => Math.abs(col.x - node.x) <= 50);
    if (!existing) {
      columns.push({ x: node.x, nodes: [node] });
    } else {
      existing.nodes.push(node);
    }
  }

  return columns
    .sort((a, b) => a.x - b.x)
    .map((c, idx) => ({
      index: idx,
      nodes: c.nodes,
      hasPending: c.nodes.some((n) => n.status === "pending" || n.status === "unknown"),
      allPassed: c.nodes.length > 0 && c.nodes.every((n) => n.status === "passed")
    }));
}

function pickCurrentTermForRegular(columns) {
  for (let i = 0; i < columns.length; i += 1) {
    const prior = columns.slice(0, i);
    const priorAllPassed = prior.length === 0 || prior.every((c) => c.allPassed);
    if (priorAllPassed && columns[i].hasPending) {
      return columns[i];
    }
  }
  return null;
}

function pickCurrentTermForIrregular() {
  // Placeholder for future irregular flow.
  return null;
}

async function scrapeModulesForCourses(context, courses, options = {}) {
  const scanMode = options.scanMode || "strict";
  const curriculumUrl = options.curriculumUrl || "https://paraverse.feutech.edu.ph/network-map/curriculum/";
  const curriculumCode = options.curriculumCode || "";
  const results = [];

  for (const course of courses) {
    const coursePage = await context.newPage();
    const courseCode = (course.courseCode || getCourseCodeFromText(course.title) || "").toUpperCase();
    const courseUrl = course.href || buildCourseMapUrl(curriculumUrl, courseCode, curriculumCode);

    // Skip noisy telemetry but allow module assets so we can resolve actual file URLs.
    await coursePage.route("**/*", (route) => {
      const url = route.request().url().toLowerCase();
      const isTelemetry =
        url.includes("google-analytics.com") ||
        url.includes("browser.events.data.microsoft.com");

      if (isTelemetry) {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });

    await coursePage.goto(courseUrl, { waitUntil: "domcontentloaded" });
    console.log(`Scanning course map: ${courseCode || course.title}`);

    const moduleLinks = await coursePage.evaluate(({ currentCourseCode, mode }) => {
      const rows = Array.from(document.querySelectorAll("li[data-role='MBG-LINE']"));
      const out = [];

      for (const row of rows) {
        const rowCourse = (row.getAttribute("data-course") || "").trim().toUpperCase();
        const status = (row.getAttribute("data-status") || "").trim().toLowerCase();
        const moduleId = (row.getAttribute("module-id") || "").trim();
        const courseId = (row.getAttribute("course-id") || "").trim();
        const moduleDataId = (row.getAttribute("data-module") || "").trim();

        const titleEl = row.querySelector(".module-title") || row.querySelector("span.module-title") || row.querySelector("a.MBG-COURSE-HEADING-MODAL");
        const title = (titleEl?.textContent || row.textContent || "").trim().replace(/\s+/g, " ");

        if (!title || !moduleId || !courseId) {
          continue;
        }

        if (currentCourseCode && rowCourse && rowCourse !== currentCourseCode) {
          continue;
        }

        if (mode === "strict" && status && status !== "active" && status !== "pending" && status !== "current") {
          continue;
        }

        out.push({
          href: "",
          title,
          moduleId,
          moduleDataId,
          courseId,
          status,
          rowCourse
        });
      }

      return out;
    }, { currentCourseCode: courseCode, mode: scanMode });

    for (let i = 0; i < moduleLinks.length; i += 1) {
      const module = moduleLinks[i];
      const selector = `li[data-course="${module.rowCourse || courseCode}"][module-id="${module.moduleId}"][course-id="${module.courseId}"] a.icon-link-child.MBG-COURSE-HEADING-MODAL`;

      try {
        const before = await coursePage.locator("iframe[src*='viewer.html?file=']").evaluateAll((els) =>
          els
            .map((el) => el.getAttribute("src") || "")
            .filter(Boolean)
        );

        let actionTriggered = false;
        actionTriggered = await coursePage.evaluate(({ cssSelector, rowCourse, courseId, moduleId, moduleTitle }) => {
            function triggerClick(el) {
              if (!el) {
                return false;
              }
              el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
              return true;
            }

            function normalize(value) {
              return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
            }

            // Step 1: make sure this module row is opened.
            const rowTitleLink = document.querySelector(
              `li[data-course="${rowCourse}"][module-id="${moduleId}"][course-id="${courseId}"] a.MBG-COURSE-HEADING-MODAL`
            ) || document.querySelector(
              `a.MBG-COURSE-HEADING-MODAL[course-id="${courseId}"][module-id="${moduleId}"]`
            );
            triggerClick(rowTitleLink);

            // Step 2: open matching module block in the dialog.
            const dlg = document.querySelector("dialog");
            const titleNeedle = normalize(moduleTitle);
            if (dlg) {
              const headings = Array.from(dlg.querySelectorAll("h3"));
              const matched = headings.find((h) => normalize(h.textContent).includes(titleNeedle));
              if (matched) {
                const clickable = matched.closest("[style*='cursor']") || matched.parentElement;
                triggerClick(clickable);

                // Step 3: inside the matched module section, click first presentation/resource button.
                const sectionRoot = clickable?.parentElement || matched.parentElement;
                if (sectionRoot) {
                  const presentationStrong = Array.from(sectionRoot.querySelectorAll("strong"))
                    .find((s) => /presentation|\[m\d+-presentation\]/i.test(s.textContent || ""));

                  if (presentationStrong) {
                    const nearBtn = presentationStrong.closest("p")?.parentElement?.querySelector("button");
                    if (triggerClick(nearBtn)) {
                      return true;
                    }
                  }

                  const anySectionBtn = sectionRoot.querySelector("button");
                  if (triggerClick(anySectionBtn)) {
                    return true;
                  }
                }
              }
            }

            const directIcon = document.querySelector(cssSelector);
            if (triggerClick(directIcon)) {
              return true;
            }

            const titleLink = document.querySelector(
              `li[data-course="${rowCourse}"][module-id="${moduleId}"][course-id="${courseId}"] a.MBG-COURSE-HEADING-MODAL`
            );
            if (triggerClick(titleLink)) {
              return true;
            }

            const anyByAttrs = document.querySelector(
              `a.MBG-COURSE-HEADING-MODAL[course-id="${courseId}"][module-id="${moduleId}"]`
            );
            return triggerClick(anyByAttrs);
          }, {
            cssSelector: selector,
            rowCourse: module.rowCourse || courseCode,
            courseId: module.courseId,
            moduleId: module.moduleId,
            moduleTitle: module.title
          });

        if (actionTriggered) {
          await delay(600);

          await coursePage.waitForTimeout(500);

          const after = await coursePage.locator("iframe[src*='viewer.html?file=']").evaluateAll((els) =>
            els
              .map((el) => el.getAttribute("src") || "")
              .filter(Boolean)
          );

          const beforeSet = new Set(before);
          const newSrc = after.find((src) => !beforeSet.has(src));
          const byCourse = after.filter((src) => src.includes(`/powerpoint/${module.courseId}/`));
          const pickedSrc = newSrc || byCourse[byCourse.length - 1] || after[after.length - 1] || "";

          if (pickedSrc) {
            const viewerUrl = new URL(pickedSrc, coursePage.url()).href;
            const directAssetUrl = extractSourceAssetUrl(viewerUrl);
            module.href = directAssetUrl || viewerUrl;
          }
        }
      } catch {
        // Keep module metadata even when no direct file link is exposed.
      }

      if (!module.href) {
        module.href = `${courseUrl}#module-${module.moduleId}`;
      }
    }

    const courseHtml = await coursePage.content();
    await coursePage.close();

    const modulePages = (moduleLinks.length ? moduleLinks : [{ href: courseUrl, title: `${course.title} Course Page` }]).map((module) => ({
      href: module.href,
      title: module.title,
      html: buildModuleStubHtml(course.title, module.title, module.href)
    }));

    results.push({
      course: {
        ...course,
        courseCode,
        href: courseUrl
      },
      scanMode,
      courseHtml,
      moduleLinks: moduleLinks.length ? moduleLinks : [{ href: courseUrl, title: `${course.title} Course Page` }],
      modulePages
    });
  }

  return results;
}

async function exportTranslatedHtml(outputDir, scrapedData, createTranslator, runtimeOptions = {}) {
  ensureDir(outputDir);
  const requestContext = runtimeOptions.requestContext;

  const manifest = [];

  for (const entry of scrapedData) {
    const courseFolder = path.join(outputDir, safeFileName(entry.course.title || entry.course.href));
    ensureDir(courseFolder);
    const coursePdfFolder = path.join(courseFolder, "pdf");

    // Keep download cache clean per run for each course.
    fs.rmSync(coursePdfFolder, { recursive: true, force: true });
    ensureDir(coursePdfFolder);

    const courseTranslator = createTranslator();
    const translatedCourseHtml = await translateHtmlPreservingMarkup(entry.courseHtml, courseTranslator);
    const courseFile = path.join(courseFolder, "course.html");
    fs.writeFileSync(courseFile, translatedCourseHtml, "utf8");

    const moduleFiles = [];
    for (let i = 0; i < entry.modulePages.length; i += 1) {
      const module = entry.modulePages[i];
      if (!module.html) {
        continue;
      }

      // Hard isolation: each module gets a fresh translator instance and chat context.
      const moduleTranslator = createTranslator();
      const translatedModuleHtml = await translateHtmlPreservingMarkup(module.html, moduleTranslator);
      const fileBase = `${String(i + 1).padStart(2, "0")}-${safeFileName(module.title)}`;
      const fileName = `${fileBase}.html`;
      const moduleFile = path.join(courseFolder, fileName);
      fs.writeFileSync(moduleFile, translatedModuleHtml, "utf8");

      const htmlEntry = { fileName, href: module.href, title: module.title, kind: "html" };
      moduleFiles.push(htmlEntry);

      // Write unified page-object JSON for this module.
      try {
        const sourcePageObj = buildPageObjectFromHtml(module.html);
        const translatedPageObj = moduleTranslator.canTranslate()
          ? await translatePageObject(sourcePageObj, moduleTranslator)
          : sourcePageObj;
        const jsonFileName = `${fileBase}.json`;
        writeModuleJson(path.join(courseFolder, jsonFileName), {
          course: entry.course.title,
          module: module.title,
          sourceUrl: module.href,
          targetLanguage: moduleTranslator.targetLanguage,
          translatedAt: new Date().toISOString()
        }, sourcePageObj, translatedPageObj);
        moduleFiles.push({ fileName: jsonFileName, href: module.href, title: module.title, kind: "page-object-json" });
      } catch (err) {
        moduleFiles.push({ fileName: "", href: module.href, title: module.title, kind: "page-object-json-error", error: err.message });
      }

      try {
        const moduleIndex = String(i + 1).padStart(2, "0");
        const pptxName = `${String(i + 1).padStart(2, "0")}-${safeFileName(module.title)}.translated.pptx`;
        const pptxPath = path.join(courseFolder, pptxName);
        const moduleKey = `${safeFileName(entry.course.courseCode || entry.course.title)}-${String(i + 1).padStart(2, "0")}-${safeFileName(module.title)}`;
        const cacheFileBasePath = path.join(coursePdfFolder, `${moduleIndex}-${safeFileName(module.title)}.source`);
        const pptxResult = await generateTranslatedPptFromPdf({
          requestContext,
          moduleHref: module.href,
          moduleTitle: module.title,
          moduleKey,
          cacheFileBasePath,
          outputPptxPath: pptxPath,
          translator: moduleTranslator,
          logger: (msg) => console.log(msg)
        });

        if (pptxResult.generated) {
          const cacheName = path.basename(pptxResult.cacheFilePath || "");
          if (cacheName) {
            moduleFiles.push({
              fileName: path.join("pdf", cacheName),
              href: module.href,
              title: module.title,
              kind: "cached-source-pdf",
              cacheHit: Boolean(pptxResult.cacheHit)
            });
          }

          moduleFiles.push({
            fileName: pptxName,
            href: module.href,
            title: module.title,
            kind: "translated-pptx",
            sourceAssetUrl: pptxResult.sourceAssetUrl,
            pageCount: pptxResult.pageCount
          });

          const sourcePagesJsonName = `${String(i + 1).padStart(2, "0")}-${safeFileName(module.title)}.source-pages.json`;
          const sourcePagesJsonPath = path.join(courseFolder, sourcePagesJsonName);
          fs.writeFileSync(sourcePagesJsonPath, JSON.stringify(pptxResult.sourcePageObject, null, 2), "utf8");
          moduleFiles.push({
            fileName: sourcePagesJsonName,
            href: module.href,
            title: module.title,
            kind: "per-page-source-json"
          });

          const translatedPagesJsonName = `${String(i + 1).padStart(2, "0")}-${safeFileName(module.title)}.translated-pages.json`;
          const translatedPagesJsonPath = path.join(courseFolder, translatedPagesJsonName);
          fs.writeFileSync(translatedPagesJsonPath, JSON.stringify(pptxResult.translatedPageObject, null, 2), "utf8");
          moduleFiles.push({
            fileName: translatedPagesJsonName,
            href: module.href,
            title: module.title,
            kind: "per-page-translated-json"
          });

          // Unified page-object JSON combining original + translated per page.
          const pdfJsonName = `${String(i + 1).padStart(2, "0")}-${safeFileName(module.title)}.pdf.json`;
          writeModuleJson(path.join(courseFolder, pdfJsonName), {
            course: entry.course.title,
            module: module.title,
            sourceUrl: pptxResult.sourceAssetUrl,
            targetLanguage: moduleTranslator.targetLanguage,
            translatedAt: new Date().toISOString()
          }, pptxResult.sourcePageObject, pptxResult.translatedPageObject);
          moduleFiles.push({
            fileName: pdfJsonName,
            href: module.href,
            title: module.title,
            kind: "page-object-pdf-json"
          });
        } else {
          if (pptxResult.cacheFilePath) {
            moduleFiles.push({
              fileName: path.join("pdf", path.basename(pptxResult.cacheFilePath)),
              href: module.href,
              title: module.title,
              kind: "cached-source-asset",
              cacheHit: Boolean(pptxResult.cacheHit),
              assetType: pptxResult.assetType || "unknown"
            });
          }

          moduleFiles.push({
            fileName: "",
            href: module.href,
            title: module.title,
            kind: "translated-pptx-skipped",
            reason: pptxResult.reason || "unknown"
          });
        }
      } catch (err) {
        moduleFiles.push({
          fileName: "",
          href: module.href,
          title: module.title,
          kind: "translated-pptx-error",
          error: err.message
        });
      }
    }

    const modulesMeta = [];
    for (let i = 0; i < entry.moduleLinks.length; i += 1) {
      modulesMeta.push({
        index: i + 1,
        title: entry.moduleLinks[i].title,
        href: entry.moduleLinks[i].href
      });
    }

    manifest.push({
      courseTitle: entry.course.title,
      courseUrl: entry.course.href,
      folder: courseFolder,
      moduleLinks: modulesMeta,
      moduleFiles
    });
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return manifestPath;
}

module.exports = {
  launchContext,
  waitForLogin,
  extractCourseNodes,
  clusterByColumn,
  pickCurrentTermForRegular,
  pickCurrentTermForIrregular,
  scrapeModulesForCourses,
  exportTranslatedHtml
};
