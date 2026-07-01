"use strict";
// Barrel: re-exports browser action tools split across lib/browserActions/{core,storage,network,a11y}.js
// (pure refactor of the former single 872-line file — no behavior change).
module.exports = {
  ...require("./browserActions/core"),
  ...require("./browserActions/storage"),
  ...require("./browserActions/network"),
  ...require("./browserActions/a11y"),
};
