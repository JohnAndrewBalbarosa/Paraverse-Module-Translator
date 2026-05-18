/**
 * Pipeline composer.
 *
 * Pattern: a flat list of named stages. Each stage is a self-contained
 * module that reads/writes a shared `context` object. Stages don't know
 * about each other — they're composed here.
 *
 * To add a new stage (e.g., a hypothetical "endOfModuleDiscussionCheck"
 * required by a future school policy change):
 *   1. Create src/stages/endOfModuleDiscussionCheck.js exporting
 *      { name, run, canSkip? }
 *   2. Add it to STAGES below, at the appropriate position
 *   3. Optionally use canSkip() to opt out based on context (e.g., only run
 *      when context.cliArgs.checkDiscussion is true)
 *
 * No existing stage file needs to change. That's the whole point.
 */

const discover = require("./stages/discover");
const selectCourses = require("./stages/selectCourses");
const scrape = require("./stages/scrape");
const download = require("./stages/download");
const extract = require("./stages/extract");
const translate = require("./stages/translate");
const render = require("./stages/render");
const pkg = require("./stages/package");

const STAGES = [
  discover,
  selectCourses,
  scrape,
  download,
  extract,
  translate,
  render,
  pkg
];

/**
 * @param {object} initialContext - starting context (config, http, cliArgs, ...)
 * @param {object} deps - { log: fn(msg) }
 * @param {object} [opts] - { stages?: array, stopAfter?: string }
 */
async function runPipeline(initialContext, deps = {}, opts = {}) {
  const log = deps.log || (() => {});
  const stages = opts.stages || STAGES;
  let ctx = initialContext || {};

  for (const stage of stages) {
    if (stage.canSkip && stage.canSkip(ctx)) {
      log(`[pipeline] -- skip ${stage.name}`);
      if (opts.stopAfter === stage.name) break;
      continue;
    }
    log(`[pipeline] >> ${stage.name}`);
    ctx = await stage.run(ctx, { log });
    if (opts.stopAfter === stage.name) {
      log(`[pipeline] stopAfter=${stage.name} reached`);
      break;
    }
  }

  return ctx;
}

module.exports = {
  runPipeline,
  STAGES,
  stagesByName: Object.fromEntries(STAGES.map((s) => [s.name, s]))
};
