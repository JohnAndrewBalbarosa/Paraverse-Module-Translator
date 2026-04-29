# `src/translation/`

This folder is the blueprint for the future translation layer.

The files here should be reusable from both HTML export and PDF conversion without depending on Playwright or filesystem concerns.

## Planned Files

- `htmlTranslator.js`: markup-preserving HTML translation
- `translatorClient.js`: provider-facing translation client
- `pageObjectTranslator.js`: structured `PAGE n` translation workflow
