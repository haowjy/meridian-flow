// CJS config so that require() can resolve vitest from NODE_PATH
// (which vitest's shell script sets to include the frontend's pnpm node_modules)
const path = require("path");

const CM6_COLLAB_DEPS = path.join(
  __dirname,
  "../../frontend/node_modules/.pnpm/@meridian+cm6-collab@file+..+packages+cm6-collab/node_modules",
);

/** @type {import('vitest/config').UserConfig} */
module.exports = {
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      yjs: path.join(CM6_COLLAB_DEPS, "yjs"),
    },
  },
};
