# TODO

## Recorder UI

- [x] **Workaround**: patch Playwright Recorder CSS to force vertical + horizontal scroll on overflowing panels.
  - Script: [scripts/patch-recorder-ui.js](scripts/patch-recorder-ui.js)
  - Wired into `npm run record` and `postinstall`.
  - Touches `node_modules/playwright-core/lib/vite/recorder/assets/index-*.css` (gets re-applied automatically after `npm install`).

- [ ] **Proper fix**: replace the CSS patch with a non-invasive approach so we don't touch `node_modules`.
  - Option A: open an upstream issue / PR on `microsoft/playwright` about Recorder panel overflow at small window sizes.
  - Option B: ship our own minimal recorder UI (custom Playwright client app) that reuses `context._enableRecorder` and renders generated code in a panel we control.
  - Option C: bypass the Recorder UI entirely — stream generated code straight to `recorded.js` via `_enableRecorder({ outputFile })` and skip the Inspector window. Already partly wired in [scripts/record.js](scripts/record.js); confirm it works without `page.pause()` and remove the patch dependency.
  - Acceptance: `npm run record` no longer needs to modify `node_modules`, and overflow is non-issue regardless of window size.

## Scraper alignment with recorded UI flow

See [docs/recording-journey.md](docs/recording-journey.md) for the captured flow.

- [x] **Bypass the Print → Save dialog** — implemented via network-response interception in [src/pdfCapture.js](src/pdfCapture.js). Listens for `application/pdf` responses while the UI loads the viewer; saves the buffer directly. No print dialog, no OS save prompt.
- [x] **Standalone runner** — [scripts/download-module.js](scripts/download-module.js) follows the recorded UI flow per course and saves every module PDF to `output/<course>/pdf/`. Run via `npm run download -- "GED GED0085  ACTIVE"`.
- [ ] **Verify GED0085 path** works end-to-end. The recording showed the user had to double-click the module list item — the runner already retries via `getByRole('link').first().click()` then waits for `Load Presentation` to be visible. Confirm with a real run.
- [ ] **Integrate PDF capture into main scraper.** Replace the URL-extraction in [src/paraverse.js](src/paraverse.js) (lines ~349–372 — the `iframe[src*='viewer.html?file=']` extraction that falls back to `${courseUrl}#module-${moduleId}`) with `capturePdfToFile`. Currently the fallback URL is what writes useless stubs like `output/GED_GED0085/01-...html` pointing back at the curriculum map.
- [ ] **Replace positional selectors** (`.first()`, `.nth(1)` on `Load Presentation`) with attribute-based ones once the DOM is mapped properly.

## Recording workflow

- [x] **Video + trace capture**: every `npm run record` session now writes to `recordings/<timestamp>/`:
  - `video/*.webm` — full screen recording
  - `trace.zip` — step-by-step screenshots, DOM snapshots, network, console
  - View with: `npx playwright show-trace recordings/<timestamp>/trace.zip`
- [ ] After first successful recording, take the generated `recorded.js` and adapt selectors / flow into [src/paraverse.js](src/paraverse.js) (or a new helper) to replace fragile selectors in the scraper.
- [ ] Document the recording workflow in [README.md](README.md): `npm run login` → `npm run record` → review `recorded.js` + trace.
