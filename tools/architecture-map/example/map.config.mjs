export default {
  title: "Example architecture",
  root: ".",
  repo: "example/toy",
  branch: "main",
  pagesDir: "architecture",
  tokens: {
    files: [{ file: "tokens.css", blocks: [":root", '[data-theme="dark"]'] }],
    dark: { attribute: "data-theme", value: "dark" },
  },
  services: { glob: "services/*", page: "system.md" },
  coverage: [{ glob: "services/*" }, { glob: "services/api/src/*" }],
  imports: { workspaces: ["services/*"], aliases: [] },
  dependencies: {
    page: "dependencies.md",
    rules: [{ rule: "modules are acyclic", cycle: "services/api/src/*" }],
  },
  nav: { journeys: "Journeys", dependencies: "Dependencies" },
};
