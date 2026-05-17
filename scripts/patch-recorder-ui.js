const fs = require("node:fs");
const path = require("node:path");

const MARKER = "/* paraverse-recorder-scroll-patch */";

const OVERRIDE_CSS = `
${MARKER}
html, body, #root { height: 100%; min-height: 0; min-width: 0; }
.vbox, .hbox { min-height: 0; min-width: 0; }
.recorder, .recorder > *, .vbox.recorder { min-height: 0; min-width: 0; }
.source-tab, .source, .source-tab-content,
.cm-editor, .cm-scroller,
.call-log, .actions-list,
.sidebar, .toolbar-pane, .tab-strip-content,
.tabbed-pane, .tabbed-pane-content,
[class*="panel"], [class*="Panel"],
[class*="container"], [class*="Container"] {
  overflow: auto !important;
  min-height: 0 !important;
  min-width: 0 !important;
}
.cm-scroller { overflow-x: auto !important; overflow-y: auto !important; }
pre, code, .CodeMirror-line { white-space: pre !important; }
* { scrollbar-width: thin; }
`;

function patchFile(cssPath) {
  let css = fs.readFileSync(cssPath, "utf8");
  const markerIdx = css.indexOf(MARKER);
  if (markerIdx !== -1) {
    css = css.slice(0, markerIdx).replace(/\s+$/, "");
    console.log(`[patch-recorder-ui] Removed previous patch in: ${cssPath}`);
  }
  fs.writeFileSync(cssPath, css + "\n" + OVERRIDE_CSS, "utf8");
  console.log(`[patch-recorder-ui] Patched: ${cssPath}`);
  return true;
}

function main() {
  const dir = path.resolve(
    process.cwd(),
    "node_modules/playwright-core/lib/vite/recorder/assets"
  );
  if (!fs.existsSync(dir)) {
    console.log(`[patch-recorder-ui] Recorder assets not found at ${dir} (skipping)`);
    return;
  }

  const cssFiles = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("index-") && f.endsWith(".css"));

  if (!cssFiles.length) {
    console.log("[patch-recorder-ui] No index-*.css files found (skipping)");
    return;
  }

  for (const file of cssFiles) {
    patchFile(path.join(dir, file));
  }
}

main();
