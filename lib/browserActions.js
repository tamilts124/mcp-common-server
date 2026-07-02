"use strict";
// Barrel: re-exports browser action tools split across
// lib/browserActions/{core,interaction,pageState,capture,scripting,storage,network,a11y,dialogs,frames}.js
// (pure refactor of the former single 872-line file — no behavior change).
module.exports = {
  ...require("./browserActions/core"),
  ...require("./browserActions/interaction"),
  ...require("./browserActions/pageState"),
  ...require("./browserActions/capture"),
  ...require("./browserActions/scripting"),
  ...require("./browserActions/storage"),
  ...require("./browserActions/network"),
  ...require("./browserActions/a11y"),
  ...require("./browserActions/dialogs"),
  ...require("./browserActions/frames"),
};
