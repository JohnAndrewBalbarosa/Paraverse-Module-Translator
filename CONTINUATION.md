# Where we stopped — 2026-05-18

## Auto-fit overlay refactor: SHIPPED

`src/pdfOverlay.js` now has a proper fit planner:

- **New `planLineFit()`** decides per line: keep size / wrap / shrink / truncate
- **New `wrapTextIntoLines()`** does measured greedy word-wrap (no more silent overflow from `pdf-lib`'s internal wrap)
- **Available rectangle** computed against page bounds + next-line Y → no off-page rendering, no collision with content below
- **Cover rectangle** now extends to match the rendered (possibly wrapped) area, not just the source bbox → no original text peeking through
- **Diagnostics** tallied per file and per module:
  `94 fit / 168 wrap / 68 shrunk / 0 trunc / 2 no-room` style summary

## Status of translated PDFs

**60/60 `.tl.pdf` files exist on disk** — but ~30 were regenerated with the new fit-aware logic before stop, the other ~30 are still the OLD overlay output (from previous run). To finish regenerating everything, just re-run.

Modules already refreshed with new logic (per log):
- HSC_GED0061: 02 (MAN_AS_THE_AGENT), 05 (CATEGORICAL_IMPERATIVE), 07 (DISTRIBUTIVE)
- HSC_GED0073: 01-04, 07-10
- HSC_GED0085: 02-06, 08-10
- ITE_CCS0047: 01, 03, 04

Still on OLD overlay (need rerun):
- CS_CS0033: 01-04
- HSC_GED0061: 01, 03, 04, 06, 08
- HSC_GED0085: 01, 07
- ITE_CCS0047: 02, 05, 06
- IT_CS0029: all 10
- IT_CS0061: all 12

## How to resume

```powershell
npm start -- --use-saved --render --target-lang=tl
```

Idempotent — translate stage skips JSONs already on disk, render stage overwrites `.tl.pdf` cleanly with the new planner. Expect ~3-5 min for 60 modules. Each module logs a fit summary line.

After rerun, run the diagnostic scan to find modules with `truncated > 0` or `noRoom > 5`:

```powershell
node -e "const m = require('./output/manifest.json'); for (const c of m) for (const f of c.moduleFiles) if (f.overlayFit && (f.overlayFit.truncated > 0 || f.overlayFit.noRoom > 5)) console.log(c.course.title, '/', f.title, '->', JSON.stringify(f.overlayFit))"
```

## Files changed in this session

- `src/pdfOverlay.js` — added constants block, `planLineFit()`, `wrapTextIntoLines()`; refactored inner overlay loop; new `fit` field in return shape
- `src/stages/render.js` — propagates `overlayFit` from overlay result
- `src/stages/package.js` — adds `overlayFit` to manifest record

No other files touched.

## Fit-planner observed behavior (good signs)

From the partial run, the planner is making sensible decisions:
- `94 fit / 168 wrap / 68 shrunk / 0 trunc / 2 no-room` for a dense ethics module
- Across modules: 0 truncations needed (translations always fit at min font size)
- `no-room` counts are low (1-9 per module, usually 1-2) — these are extreme cases where translation is much longer than source bbox AND there's no space below

## Tunables (in `src/pdfOverlay.js` top of file)

```js
const MIN_FONT_SIZE = 6;            // never shrink below
const LINE_HEIGHT_RATIO = 1.15;     // line-spacing
const ASCENT_RATIO = 0.8;           // baseline offset
const PAGE_SAFE_MARGINS = { top: 18, right: 18, bottom: 18, left: 18 };
const COVER_PADDING = 0.5;
const SHRINK_STEP = 0.5;
const FIT_EPSILON = 1.0;
```

If layout still feels too tight after rerun, lower `MIN_FONT_SIZE` to 5 or increase `LINE_HEIGHT_RATIO` to 1.2.

## Out of scope (next time, if needed)

- Embedding a Unicode TTF font (would let us render `•` `❑` `→` etc. without ASCII substitution)
- Sampling underlying color before drawing the white cover (so dark slide headers don't show white blocks)
- Per-word position mapping (current approach is per-line — adequate for slides, less so for paragraph-heavy PDFs)
