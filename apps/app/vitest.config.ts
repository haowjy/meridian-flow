import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    exclude: ["e2e/**", "node_modules/**"],
    // jsdom implements no layout, and prosemirror-view asks a Range for its
    // rects on every caret read. Without this, an arrow key throws.
    setupFiles: ["./src/test-support/jsdom-layout.ts"],
  },
});
