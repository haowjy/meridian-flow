/*
 * Everything Meridian-specific about the architecture map. The engine (tools/architecture-map)
 * names no project; the pages in this directory are the content. The browser imports this file
 * too, so it stays plain data: no functions, no imports. tools/architecture-map/README.md has the
 * reference for each key.
 */
export default {
  // The viewer's title, and the prefix of what it remembers in the browser.
  title: "Meridian architecture",

  // The repository root, relative to this file. Every other path below is relative to it.
  root: "../..",

  // Where "on GitHub" links go.
  repo: "haowjy/meridian-flow",
  branch: "main",

  // The directory holding README.md (which lists the top-level pages), the level pages,
  // flows/, journeys/ and dependencies.md.
  pagesDir: ".context/system-architecture",

  // The viewer's colours: the custom properties these blocks declare, read from the design tokens
  // each time the viewer loads. The viewer sets `dark` on <html> for the dark theme.
  tokens: {
    files: [
      { file: "packages/design-tokens/src/ink-jade.css", blocks: [":root", "@theme"] },
      { file: "packages/design-tokens/src/themes.css", blocks: ['[data-ui-theme="dark"]'] },
    ],
    dark: { attribute: "data-ui-theme", value: "dark" },
  },

  // Each directory matching `glob` is a service: a box on `page` whose Paths are inside it and
  // whose Opens is a page named after the directory (apps/server → server.md).
  services: { glob: "apps/*", page: "system.md" },

  // Each directory matching `glob` (and holding `needs`, when given) must lie under some box's Paths.
  coverage: [
    { glob: "apps/*" },
    { glob: "packages/*", needs: "package.json" },
    { glob: "apps/server/server/domains/*" },
    { glob: "apps/app/src/features/*" },
  ],

  // How the dependency check reads imports. Workspace packages resolve by name (the `name` in
  // package.json) to their directory; an alias maps a prefix, from files under `within`.
  imports: {
    workspaces: ["apps/*", "packages/*"],
    aliases: [
      { prefix: "@/", within: "apps/app/", to: "apps/app/src/" },
      { prefix: "~/", within: "apps/www/", to: "apps/www/src/" },
    ],
  },

  // The rules dependencies.md lists breaks of. A unit is a directory matching a glob, named by its
  // last segment (domains/runtime → runtime). `cycle`: units that import each other in a loop.
  // `from`/`to`: a unit of `from` importing anything under `to`. Only value imports count.
  // `files`/`to`: a file under the directory `files` importing any module in the list `to` (a package, a
  // package subpath or a repo path), one row per file and module; type-only imports count too.
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

  // The state machine pages: the index the viewer opens, and the git pathspec that finds every
  // page the index must list.
  stateMachines: {
    index: ".context/state-machines/index.md",
    pages: "*.context/*state-machine*.md",
  },

  // Nav entries beyond the README's page list. Leave one out and the section is off.
  nav: { journeys: "Journeys", machines: "State machines", dependencies: "Dependencies" },

  // What the dev server shows in the viewer. true: any tracked file opens at its repo path.
  // false: only the pages directory and the Markdown matched by `docs`. `pnpm dev:funnel`
  // publishes the dev server, so false is for a private repository.
  serveSource: true,
  docs: ["**/.context/**/*.md"],
};
