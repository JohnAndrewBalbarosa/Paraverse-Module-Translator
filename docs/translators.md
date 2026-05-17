# Translators

The `translate` pipeline stage delegates the actual translation work to a
**pluggable translator backend**. Backends live in `src/translators/` and
all conform to a small interface.

This lets the project swap between (a) an API-driven backend like Google
Gemini, (b) an offline workflow where a human or external AI fills in
translated JSONs by hand, or (c) a no-op identity passthrough — without
the pipeline knowing or caring.

## The translator interface

```js
interface Translator {
  name: string;                                  // identifier ("gemini", "manual", ...)
  canTranslate(): boolean;                       // is this backend ready to use?

  async translatePagesJson(sourceJson, opts): {
    status: "translated" | "pending" | "skipped" | "failed",
    translatedJson?: object,    // when status === "translated"
    reason?: string,            // when not translated
    expectedPath?: string,      // for "pending" status
    translatedPath?: string     // when backend wrote the file itself
  }
}
```

### Inputs

- `sourceJson` — the compact-v1 page object loaded from
  `output/<course>/json/<base>.json`. The translate stage injects
  `sourceJson.meta.sourcePath` (absolute path) so backends that need to
  compute sibling paths can.
- `opts.targetLang` — e.g. `"tl"` for Taglish. CLI: `--target-lang=tl`.

### Outputs

The backend returns a status object. The `translate` stage uses the
status to decide what to do:

- `"translated"` + `translatedJson` → stage writes the file to
  `<base>.<targetLang>.json` and records the path
- `"pending"` → stage adds the module to `translatePending[]` and prints
  a TODO list at end of run. User (or another AI) is expected to write
  the translated file. Re-running the stage picks it up.
- `"skipped"` → stage records the reason and moves on; no file written
- `"failed"` → stage records the failure; manifest reports the error

## Existing backends

### `gemini`

`src/translators/gemini.js`

- Wraps `src/translatorClient.js:TranslatorClient` which already routes
  Google's OpenAI-compatible endpoint correctly when
  `RESEARCH_PROVIDER=gemini`.
- Sends the whole compact pages JSON as a single prompt.
- Validates the model's output has identical structure before accepting.
- Returns `{ status: "translated" }` on success, `{ status: "failed" }`
  with reason on error (API failure, invalid JSON output, structure
  mismatch).

Activate with:
```powershell
$env:TRANSLATOR='gemini'
$env:RESEARCH_API_KEY='AIza...'
$env:RESEARCH_MODEL='gemini-2.5-flash'   # or gemini-2.0-flash etc.
npm start -- --translate --target-lang=tl
```

### `manual`

`src/translators/manual.js`

- The "human / external AI does the translation" backend. Default when
  no API key is configured.
- Does NOT call any API. Instead, checks whether the expected
  `<base>.<lang>.json` sibling already exists on disk.
- If present, returns `{ status: "translated", translatedJson, translatedPath }`.
- If absent, returns `{ status: "pending", expectedPath }`. The translate
  stage prints all pending files; you (or Claude, or any external
  translator) write each one, then re-run.

Typical workflow:
```powershell
$env:TRANSLATOR='manual'
npm start -- --use-saved --translate --target-lang=tl
# Pipeline lists pending source paths + expected output paths.
# Translate each source → save next to it as <base>.tl.json.
# Re-run the same command to pick up your work.
```

### `identity`

`src/translators/identity.js`

- Passthrough/no-op. Always returns `{ status: "skipped" }`.
- Use it to verify the pipeline runs end-to-end without translation
  side-effects.

## Backend selection precedence

In `src/index.js`:

```
cliArgs.translator       (--translator=manual|gemini|identity)
> config.translator      (TRANSLATOR env var)
> translators.pickDefaultBackend(config)
    └─ "gemini" if config.researchApiKey is set
    └─ otherwise "manual"
```

## Adding a new backend

Worked example: add a backend that calls Anthropic's Claude API.

1. **Create** `src/translators/anthropic.js`:

   ```js
   const Anthropic = require("@anthropic-ai/sdk");

   function create(deps) {
     const apiKey = deps && deps.config && deps.config.anthropicApiKey;
     const client = apiKey ? new Anthropic({ apiKey }) : null;
     return {
       name: "anthropic",
       canTranslate() { return Boolean(client); },
       async translatePagesJson(sourceJson, opts) {
         if (!client) return { status: "failed", reason: "no ANTHROPIC_API_KEY" };
         const targetLang = opts.targetLang || "tl";
         // Build message, call client.messages.create, parse response
         // Return { status: "translated", translatedJson }
       }
     };
   }

   module.exports = { create };
   ```

2. **Register it** in `src/translators/index.js`:

   ```js
   const anthropic = require("./anthropic");
   const BACKENDS = {
     gemini: gemini.create,
     manual: manual.create,
     identity: identity.create,
     anthropic: anthropic.create
   };
   ```

3. **Add config** in `src/config.js` if needed:

   ```js
   anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
   ```

4. **Document it** in this file.

No stage code changes. The `translate` stage uses whatever
`context.translator` is.

## Translated file shape

The `manual` and `gemini` backends produce JSON with the same compact-v1
schema as the source, with updated meta:

```json
{
  "meta": {
    "source": "01-ETHICS.source.pdf",
    "course": "HSC GED0061",
    "module": "Ethics and Its Branches",
    "pageCount": 35,
    "pageCountAfterClean": 35,
    "lineCount": 149,
    "schema": "compact-v1",
    "targetLang": "tl",
    "translator": "manual",
    "translatedAt": "2026-05-17T..."
  },
  "pages": [
    { "n": 1, "lines": [
      { "h": "Modyul 1" },
      { "h": "Pag-unawa sa Etika at Moralidad" }
    ]}
  ]
}
```

The structure must be **byte-for-byte parallel** to the source for the
verification step to pass: same `pages.length`, same `lines.length` per
page, same `h`/`p` key per item.
