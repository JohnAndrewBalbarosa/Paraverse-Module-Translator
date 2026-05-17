# Where we stopped — 2026-05-17

## Refactor: DONE (Step 1-7 of plan)

- `src/translators/` with `gemini`, `manual`, `identity` backends — built & tested
- `src/stages/` with 7 stages (`discover`, `selectCourses`, `scrape`, `download`, `extract`, `translate`, `package`) — extracted from old monolith
- `src/pipeline.js` — composer ready
- `src/index.js` — thin CLI wrapper, new flags `--translate`, `--translator=`, `--target-lang=`
- `docs/architecture.md` + `docs/translators.md` — written for future devs
- Pipeline verified end-to-end with `npm start -- --use-saved --translate --translator=manual --target-lang=tl`

## Translations done: 51 / 60

Done (51 `.tl.json` files):
- CS_CS0033: 4/4 (Gemini did these earlier)
- HSC_GED0061: 7/8 (missing #8 APPLIED_ETHICS — largest at 61KB)
- HSC_GED0073: 9/10 (missing #4 ON_INFORMAL_ARGUMENTS)
- HSC_GED0085: 9/10 (missing #4 The_Social_and_Anthropological_Construction_of_Gender)
- ITE_CCS0047: 6/6 ✓
- IT_CS0029: 9/10 (missing #1 Security_Fundamentals)
- IT_CS0061: 7/12 (missing #3 SD, #4 MM, #5 PP, #8 HCM, #9 WM)

## Pending: 9 files

```
output/HSC_GED0061/json/08-APPLIED_ETHICS.json                                       (61 KB, largest)
output/HSC_GED0073/json/04-ON_INFORMAL_ARGUMENTS.json                                 (26 KB)
output/HSC_GED0085/json/04-The_Social_and_Anthropological_Construction_of_Gender.json (26 KB)
output/IT_CS0029/json/01-Security_Fundamentals.json                                   (24 KB)
output/IT_CS0061/json/03-Sales_and_Distribution_SD.json                               (34 KB)
output/IT_CS0061/json/04-Materials_Management_MM.json                                 (36 KB)
output/IT_CS0061/json/05-Production_Planning_and_Execution_PP.json                    (36 KB)
output/IT_CS0061/json/08-Human_Capital_Management_HCM.json                            (31 KB)
output/IT_CS0061/json/09-Warehouse_Management_WM.json                                 (26 KB)
```

**Important:** 3 background translator subagents (batches 4, 5, 6) may still be running and producing files for most of the above. By the time you read this, the count may already be higher. Run this to check:

```powershell
find output -name "*.tl.json" | wc -l
```

## How to resume

### Option A: Wait for Gemini quota reset, then auto-translate

```powershell
$env:TRANSLATOR='gemini'
$env:RESEARCH_API_KEY='AIza...'
$env:RESEARCH_MODEL='gemini-2.5-flash'
npm start -- --use-saved --translate --target-lang=tl
```

The `translate` stage skips files that already have a `.tl.json` sibling (idempotent), so Gemini will only translate the remaining 9 (or however many are pending).

### Option B: Continue manual translation (Claude as AI)

In a new session, paste this prompt to Claude:

> Translate the remaining `.json` files under `output/<course>/json/` (those without a `.tl.json` sibling) into Taglish. For each source file:
> 1. Read it
> 2. Translate every `h` and `p` string value, keeping the structure 100% identical
> 3. Style: Taglish (English technical terms + Tagalog connectors), keep copyright/URL/equation/citation verbatim
> 4. Add to meta: `targetLang: "tl"`, `translator: "claude-manual"`, `translatedAt: <iso>`
> 5. Write to `<base>.tl.json` next to the source
>
> Use multiple parallel general-purpose subagents to handle batches if there are many files.

### Option C: Identity passthrough (just exit cleanly)

If you don't need translations right now and just want the pipeline to mark everything as "done":

```powershell
$env:TRANSLATOR='identity'
npm start -- --use-saved --translate --target-lang=tl
```

The `identity` backend reports `status: "skipped"` for each file — pipeline finishes cleanly, manifest still gets updated.

## Verify translations match structure

Once everything is translated, run a quick parity check:

```powershell
node -e "
const fs = require('fs'); const path = require('path');
let ok = 0, fail = 0;
for (const dir of fs.readdirSync('output')) {
  const jd = path.join('output', dir, 'json');
  if (!fs.existsSync(jd)) continue;
  for (const f of fs.readdirSync(jd)) {
    if (!f.endsWith('.json') || f.endsWith('.tl.json')) continue;
    const tl = path.join(jd, f.replace('.json', '.tl.json'));
    if (!fs.existsSync(tl)) { console.log('MISSING', f); fail++; continue; }
    const src = JSON.parse(fs.readFileSync(path.join(jd, f), 'utf8'));
    const trn = JSON.parse(fs.readFileSync(tl, 'utf8'));
    if (src.pages.length !== trn.pages.length) { console.log('PAGES MISMATCH', f); fail++; continue; }
    let mismatch = false;
    for (let i = 0; i < src.pages.length; i++) {
      if (src.pages[i].lines.length !== trn.pages[i].lines.length) { mismatch = true; break; }
    }
    if (mismatch) { console.log('LINES MISMATCH', f); fail++; continue; }
    ok++;
  }
}
console.log('OK:', ok, 'FAIL:', fail);
"
```

## Files / docs to read first when resuming

- `docs/architecture.md` — pipeline + stages explained
- `docs/translators.md` — backend interface
- `src/pipeline.js` — STAGES list (current order)
- `src/stages/translate.js` — how files get queued for manual backend
- `src/translators/manual.js` — what "manual" mode looks for on disk
