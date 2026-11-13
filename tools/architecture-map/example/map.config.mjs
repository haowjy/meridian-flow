/*
 * A toy project for the architecture map engine: two level pages, one journey, a fake source tree.
 * Check it:  node tools/architecture-map/check.mjs tools/architecture-map/example/map.config.mjs
 * View it:   node tools/architecture-map/serve.mjs tools/architecture-map/example/map.config.mjs
 * The README next to the engine explains every key.
 */
export default {
  title: "Example architecture",
  root: ".", // this directory
  repo: "example/toy", // "on GitHub" links point at a repository that doesn't exist
  branch: "main",
  pagesDir: "architecture",
  styles: "architecture/styles/tokens.css", // a copy of the engine's palette; no `tokens` key, so nothing keeps it in step with a source
  services: { glob: "services/*", page: "system.md" },
  coverage: [{ glob: "services/*" }, { glob: "services/api/src/*" }],
  imports: { workspaces: ["services/*"], aliases: [] },
  dependencies: {
    page: "dependencies.md",
    rules: [{ rule: "modules are acyclic", cycle: "services/api/src/*" }],
  },
  nav: { journeys: "Journeys", dependencies: "Dependencies" },
};
