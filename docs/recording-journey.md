# Recorded UI Journey — Paraverse Module Download

Captured via `npm run record` on the GED0085 module.

## Flow

1. **Login** (auto via persistent profile, or via Microsoft SSO):
   - `[data-test-id="<email>"]` → click
   - "Approve" prompt → click
2. **Curriculum page**: `https://paraverse.feutech.edu.ph/network-map/curriculum`
3. **Course button**: `getByRole('button', { name: '<DEPT> <CODE>  ACTIVE' })`
   - Example: `'GED GED0085  ACTIVE'`
4. **Access Map link**: `getByRole('link', { name: 'Access Map' })`
5. **Module list item**: `getByRole('listitem').filter({ hasText: 'Module N: <title>' }).getByRole('link')`
   - Sometimes needs two clicks to expand
6. **Active sidebar item**: `.border-start.border-active` (first)
7. **Load Presentation button**: `getByTitle('Load Presentation')`
   - Multiple instances exist; `.first()` and `.nth(1)` both relevant
8. **PDF Viewer iframe**: `iframe[title="PDF Viewer"]`
   - Toolbar: `#toolbarViewer`
   - Zoom: `#scaleSelect` → `selectOption('page-fit')`
   - Print button: `getByRole('button', { name: 'Print' })`
9. **PDF.js print preparation dialog** (in-page, inside iframe):
   ```html
   <dialog id="printServiceDialog">
     <span data-l10n-id="pdfjs-print-progress-message">Preparing document for printing…</span>
     <progress value="100" max="100"></progress>
     <span class="relative-progress">100%</span>
     <button id="printCancel">Cancel</button>
   </dialog>
   ```
   - Wait for `progress[value="100"]` (or for the dialog to disappear) before next step.
10. **Chrome native print preview** opens at OS level:
    - Default destination: **"Microsoft Print to PDF"** (Windows)
    - User must pick file name + folder manually
    - **Playwright cannot drive this dialog** — it is OS-level, outside the browser DOM.

## Pain points

- **OS-level print dialog**: clicking Print eventually opens Chrome's native preview, which Playwright cannot interact with. The "Save As" prompt is OS-level.
- **PDF.js preparation delay**: `#printServiceDialog` blocks the page while the PDF is being rendered for print. Often a few seconds; sometimes laggy.
- **Lag** between clicks (especially expanding the module list item — needed double-click).
- **Multiple "Load Presentation" buttons** with the same title — must rely on positional selectors.

## Better automation paths (TODO)

**Do NOT click Print.** Print triggers PDF.js preparation + OS-level Chrome print dialog, both of which Playwright cannot drive reliably. Instead:

1. Read the PDF Viewer iframe's `src` attribute → it is `viewer.html?file=<encoded PDF URL>`.
2. Decode the `?file=` param → that is the raw authenticated PDF URL.
3. Fetch directly via `context.request.get(url)` (cookies are already attached) → write the response body to `output/<course>/<module>.pdf`.
4. Done — no print, no dialog, no manual save.

The existing scraper already does most of this in [src/paraverse.js](../src/paraverse.js) via `iframe[src*='viewer.html?file=']` and `extractSourceAssetUrl` from [src/pdfPptTranslate.js](../src/pdfPptTranslate.js). Action items:

- [ ] Confirm the scraper successfully picks up the `viewer.html?file=` URL for the recorded GED0085 module path.
- [ ] If it falls back to opening the PDF Viewer toolbar (e.g. clicks toolbar/print path), patch it to skip those steps.
- [ ] Replace fragile selectors (`.nth(1)`, `.first()` on `Load Presentation`) with attribute-based ones (closest `module-id` ancestor) once the DOM is mapped.
- [ ] Wait strategy for `Load Presentation` after expanding the module — the recording showed two clicks were needed; codify a `waitFor({ state: 'visible' })` instead.
