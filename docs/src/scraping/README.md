# `src/scraping/`

This folder is the blueprint for the future Paraverse-facing layer.

The files in this folder should own authenticated browser access, curriculum interpretation, and course-level scrape/export work.

## Planned Files

- `browserSession.js`: browser startup and login readiness
- `termDetector.js`: curriculum-node parsing and current-term selection
- `coursePipeline.js`: selected-course scraping and translated HTML export
