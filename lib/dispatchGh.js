'use strict';
// ── GH CLIENT DISPATCH ────────────────────────────────────────────────────
const { ghRun } = require('./ghClientOps');

const GH_DISPATCH = {
  gh_client(args) {
    return ghRun(args);
  },
};

module.exports = { GH_DISPATCH };
