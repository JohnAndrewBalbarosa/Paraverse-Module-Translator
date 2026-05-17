# Architecture

The pipeline is a **list of stages** sharing a mutable **context** object.
Each stage lives in its own file under `src/stages/` and only reads/writes
the context. Stages do **not** call each other directly. The composer
(`src/pipeline.js`) is the only place where order is declared.

This separation lets future maintainers add, remove, or reorder stages
without touching any other code. That's the entire point of the design.

```
src/
├── index.js              ← CLI: parse flags, build initial context, runPipeline
├── pipeline.js           ← composer: STAGES array + runPipeline()
├── stages/
│   ├── discover.js       ← fetch curriculum → courses[] + currentTerm
│   ├── selectCourses.js  ← prompt or auto-pick → selectedCourses[]
│   ├── scrape.js         ← per-course module discovery → scrapedModules[]
│   ├── download.js       ← cache PDFs → downloadedModules[]
│   ├── extract.js        ← PDF → compact JSON → extractedModules[]
│   ├── translate.js      ← pluggable translator → translatedModules[]
│   └── package.js        ← write manifest + verification report
├── translators/          ← pluggable translation backends (see translators.md)
├── htmlExtract.js        ← cheerio parsers (pure, reused by discover + scrape)
├── pdfToJson.js          ← PDF text extraction (reused by extract)
├── pdfPptTranslate.js    ← cacheAsset, detectAssetType (reused by download)
├── httpClient.js         ← node-fetch wrapper w/ cookies (reused by discover/scrape)
├── cookieJar.js          ← cookie load/save (reused by httpClient)
└── utils.js              ← safeFileName, ensureDir (reused everywhere)
```

## The stage contract

Every stage file must export exactly this shape:

```js
module.exports = {
  name: "stageName",          // string, lowercase, used in logs

  async run(context, deps) {  // does the work
    // ...
    return updatedContext;    // immutable-style; return new context
  },

  canSkip(context) {          // optional; default = never skip
    return Boolean(context.someFlag);
  }
};
```

- **`context`** is the shared state. Stages read what they need and add
  fields when they produce output. By convention, stages don't mutate
  fields written by earlier stages — they add new fields instead.
- **`deps`** is `{ log }` for now. Future shared deps (loggers, metrics,
  feature flags) get added here so stage files don't have to import them
  individually.
- **`canSkip`** runs before `run`. Return `true` if the stage's output is
  already present in context (e.g., `--use-saved` mode pre-populates
  `downloadedModules`, so download/scrape/discover all skip).

## The context object (current shape)

```
context = {
  // Set by index.js before pipeline starts
  config,           // env-derived config
  cliArgs,          // parsed CLI flags
  http,             // HttpClient (auth-aware fetch wrapper)
  translator,       // chosen translator backend instance

  // Set by discover stage
  curriculum: { nodes, columns, currentTerm },

  // Set by selectCourses stage
  selectedCourses: [],

  // Set by scrape stage
  scrapedModules: [
    { course, modules: [{ title, courseId, moduleId, assetUrl, status, ... }] }
  ],

  // Set by download stage
  downloadedModules: [
    { course, courseFolder, modules: [{ ...module, cachedPath, ext, status }] }
  ],

  // Set by extract stage
  extractedModules: [
    { course, courseFolder, modules: [{ ...module, jsonPath, pageCount, lineCount, bytes, status }] }
  ],

  // Set by translate stage (when --translate)
  translatedModules: [
    { course, courseFolder, modules: [{ ...module, translatedPath, translateStatus, translateReason }] }
  ],
  translatePending: [{ course, module, sourcePath, expectedPath }],

  // Set by package stage
  manifestPath
}
```

Stage authors should treat earlier-stage fields as read-only. If you need
to enrich an upstream object, copy it into a new field with the suffixed
name (e.g., `scrapedModules` → `downloadedModules`).

## Adding a new stage

Worked example: school adds a "end of module discussion check" policy.
You need to verify that every module's discussion thread was completed
before downloading the next-term PDFs.

1. **Create the file** `src/stages/checkDiscussion.js`:

   ```js
   const fetch = require("node-fetch"); // or use context.http

   async function run(context, deps) {
     const log = (deps && deps.log) || (() => {});
     log(`[checkDiscussion] verifying discussion completion`);

     const checked = [];
     for (const entry of context.scrapedModules) {
       const missing = [];
       for (const m of entry.modules) {
         const ok = await checkOne(context.http, m);
         if (!ok) missing.push(m.title);
       }
       checked.push({
         course: entry.course,
         modules: entry.modules,
         discussionGaps: missing
       });
     }

     return { ...context, discussionChecked: checked };
   }

   async function checkOne(http, module) {
     // call discussion endpoint, return boolean
     return true;
   }

   function canSkip(context) {
     return !(context.cliArgs && context.cliArgs.checkDiscussion);
   }

   module.exports = { name: "checkDiscussion", run, canSkip };
   ```

2. **Register it** in `src/pipeline.js`:

   ```js
   const checkDiscussion = require("./stages/checkDiscussion");
   const STAGES = [discover, selectCourses, scrape, checkDiscussion, download, extract, translate, pkg];
   ```

3. **Wire the CLI flag** in `src/index.js:parseArgs`:

   ```js
   checkDiscussion: argv.includes("--check-discussion"),
   ```

That's it. No other file changes. The download stage doesn't even know
the check exists — it just reads `context.scrapedModules` like before. If
the school later drops the policy, remove the line from `STAGES` and the
stage file. No regressions in unrelated code.

## Pipeline composition

The composer in `src/pipeline.js`:

```js
async function runPipeline(initialContext, deps, opts) {
  let ctx = initialContext;
  for (const stage of (opts.stages || STAGES)) {
    if (stage.canSkip && stage.canSkip(ctx)) continue;
    ctx = await stage.run(ctx, deps);
    if (opts.stopAfter === stage.name) break;
  }
  return ctx;
}
```

Useful for tests:

```js
// Run only the extract stage with hand-built input
const { stagesByName } = require("./src/pipeline");
const ctx = await stagesByName.extract.run({
  downloadedModules: [/* hand-built */]
}, { log: () => {} });
```

## Why this layout

1. **Newbie-friendly.** Each stage file fits in one screen. Reading
   `stages/extract.js` tells you everything `extract` does — no need to
   trace into a 300-line orchestrator.
2. **Policy-change-friendly.** The school's stated risk ("they suddenly
   release a new pakulo before letting students proceed to the next
   module") is handled by adding/removing a stage file. Existing code
   doesn't see the change.
3. **Test-friendly.** Each stage is a pure-ish function. You can drive it
   with a synthetic context and assert the output context without
   spinning up the full pipeline.
4. **Swap-friendly.** The translator is a separate pluggable interface
   (`src/translators/`) so the translation backend can change without
   touching any stage.

## What doesn't belong in a stage

- **CLI parsing** → `index.js`
- **Stage ordering** → `pipeline.js`
- **HTTP auth/session logic** → `cookieJar.js` + `httpClient.js`
- **Pure parsing helpers** → `htmlExtract.js`, `pdfToJson.js`
- **Translator API calls** → `translators/*.js`

If a stage starts importing CLI-prompt or auth code, that's a smell —
move it out into the appropriate utility module.
