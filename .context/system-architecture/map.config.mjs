/*
 * Everything Meridian-specific about the architecture map. The engine (tools/architecture-map)
 * names no project; the pages in this directory are the content. The browser imports this file
 * too, so it stays plain data: no functions, no imports. tools/architecture-map/README.md has the
 * reference for each key.
 */
export default {
  title: "Meridian architecture",

  root: "../..",

  repo: "haowjy/meridian-flow",
  draft: "main",

  pagesDir: ".context/system-architecture",

  tokens: {
    files: [
      { file: "packages/design-tokens/src/ink-jade.css", blocks: [":root", "@theme"] },
      { file: "packages/design-tokens/src/themes.css", blocks: ['[data-ui-theme="dark"]'] },
    ],
    dark: { attribute: "data-ui-theme", value: "dark" },
  },

  services: { glob: "apps/*", page: "system.md" },

  coverage: [
    { glob: "apps/*" },
    { glob: "packages/*", needs: "package.json" },
    { glob: "apps/server/server/domains/*" },
    { glob: "apps/app/src/features/*" },
  ],

  imports: {
    workspaces: ["apps/*", "packages/*"],
    aliases: [
      { prefix: "@/", within: "apps/app/", to: "apps/app/src/" },
      { prefix: "~/", within: "apps/www/", to: "apps/www/src/" },
    ],
  },

  dependencies: {
    page: "dependencies.md",
    rules: [
      { rule: "domains are acyclic", cycle: "apps/server/server/domains/*" },
      { rule: "domains do not import lib/", from: "apps/server/server/domains/*", to: "apps/server/server/lib" },
      { rule: "packages do not import apps", from: "packages/*", to: "apps/*" },
      {
        rule: "the runtime does not import document, billing or Work code",
        files: "apps/server/server/domains/runtime",
        to: [
          "@meridian/agent-edit",
          "@meridian/markup",
          "@meridian/contracts/works",
          "apps/server/server/domains/context",
          "apps/server/server/domains/billing",
          "apps/server/server/domains/projects",
          "apps/server/server/domains/file-policy",
          "apps/server/server/domains/packages",
          "apps/server/server/domains/notices",
          "apps/server/server/domains/storage",
        ],
      },
    ],
  },

  stateMachines: {
    index: ".context/state-machines/index.md",
    pages: "*.context/*state-machine*.md",
  },

  nav: { journeys: "Journeys", machines: "State machines", dependencies: "Dependencies" },

  serveSource: true,
  docs: ["**/.context/**/*.md"],
};
