# Paraverse Module Translator

Scrapes your **current term** modules from Paraverse curriculum map and exports translated HTML while preserving module images and markup.

## What this does

- Regular-student flow: identifies the first pending column after fully passed columns.
- Irregular-student flow: placeholder only (safe no-op for now).
- Scrapes each course in the detected term.
- Exports translated HTML for each course page and each module page while keeping tags, images, and overall appearance.
- Prompts target language and style in the terminal at runtime.
- Uses isolated AI context per module page (fresh translator/chat instance each module).
- Provides a post-scrape CLI menu to review detected modules before translation/export.
- Supports re-scan modes to avoid pulling prerequisite/network-map links by accident.
- Lets you select which current-term courses to include before scraping modules.
- Can generate a strict-vs-relaxed diff report at `output/audit-strict-vs-relaxed.json`.
- Generates `output/manifest.json` linking courses and module URLs.

## Setup

1. Install Node.js 18+.
2. In this project folder, run:
   - `npm install`
3. Copy `.env.example` to `.env` and edit values:
   - Add `RESEARCH_PROVIDER`, `RESEARCH_MODEL`, and `RESEARCH_API_KEY` to enable translation.
   - Optional: set `RESEARCH_BASE_URL` for OpenAI-compatible endpoints.
   - Optional: set fallback `TARGET_LANGUAGE` and `TRANSLATION_STYLE`.

## Usage

1. Initialize login session:
   - `npm run login`
   - A browser opens. Sign in with your FEU account.
2. Run scraper + translator:
   - `npm start`
   - The app prompts in terminal for language and style.
    - The app first asks which detected current-term courses to include.
   - Before translation, the app opens a review menu where you can:
     - inspect all detected module links
     - validate expected module counts per course
     - re-scan in strict or relaxed mode
       - generate strict-vs-relaxed audit JSON report
     - continue or abort
3. Check outputs:
   - translated course + module files under `output/<course_name>/`
   - metadata at `output/manifest.json`

## Notes on your requested logic

- The script targets the column where:
  - all prior columns are passed
  - current column has pending/unknown courses
- This aligns with your "target just one pending column after all passed" requirement.
- Irregular mode is intentionally a placeholder in `src/paraverse.js` (`pickCurrentTermForIrregular`).

## Known limitations

- Paraverse is authentication-protected, so scraping must run locally using your own login.
- If site CSS classes change, update selectors/status detection in `src/paraverse.js`.
- Playwright is already included via npm dependency and used by this project.
- For best translation quality (especially Taglish), use a capable model and matching provider endpoint.

## Future enhancement ideas

- Implement irregular-term detection strategy based on mixed passed/pending prerequisites.
- Open each module link and export translated module pages (not just course page).
- Add retry/backoff and selector config file.
