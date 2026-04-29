# `src/runtime/`

This folder is the blueprint for the future runtime layer.

These files should exist only to coordinate the CLI flow and user interaction. They should not contain DOM scraping internals, translation HTTP calls, or file-format conversion code.

## Planned Files

- `main.js`: entrypoint and top-level runtime orchestration
- `reviewWorkflow.js`: course selection, review menu, validation, and audit prompts
