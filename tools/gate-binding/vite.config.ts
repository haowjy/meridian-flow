import { defineConfig } from "vite";

export default defineConfig({
  // The base64 build carries its WASM inline, so no WASM plugin is needed; one alias keeps the
  // binding and the page on the same loro-crdt instance (`instanceof LoroMap` depends on it).
  resolve: { alias: [{ find: /^loro-crdt$/, replacement: "loro-crdt/base64" }] },
  server: { host: "127.0.0.1" },
});
