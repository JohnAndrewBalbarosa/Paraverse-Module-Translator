# `src/support/`

This folder is the blueprint for the future shared-support layer.

These files should contain only cross-cutting helpers that other folders can import without pulling in runtime or scraper behavior.

## Planned Files

- `config.js`: normalized runtime configuration
- `fileUtils.js`: shared filesystem, naming, and delay helpers
