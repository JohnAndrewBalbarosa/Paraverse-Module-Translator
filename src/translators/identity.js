/**
 * Identity translator — returns the source JSON unchanged.
 * Useful as a safety net when no translator is configured, so the pipeline
 * doesn't crash on the translate stage.
 */

function create() {
  return {
    name: "identity",
    canTranslate() {
      return true;
    },
    async translatePagesJson(sourceJson /*, opts */) {
      return {
        status: "skipped",
        reason: "identity translator does not translate (passthrough)"
      };
    }
  };
}

module.exports = { create };
