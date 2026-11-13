# architecture-map

A viewer and a drift check for a project's architecture pages. The pages are Markdown with one
Mermaid diagram each, so they read on GitHub and in an editor as they do in the viewer. The
viewer draws each page as a clickable map, renders Markdown, journeys and state machine pages,
and opens every file in the repo (source, directories, Markdown) inside itself. The check fails
when the pages drift from the code: a path that is gone, a service with no page, a directory no
box covers, a dependency break nobody wrote down.

[example/](example/) is a working toy: a config, two level pages, a journey and a fake source
tree. Read it first.

```sh
node tools/architecture-map/check.mjs tools/architecture-map/example/map.config.mjs
node tools/architecture-map/serve.mjs tools/architecture-map/example/map.config.mjs   # http://localhost:4848/architecture/
```

## Adopting it

1. Copy this directory into the project (`tools/architecture-map/`). There is no package: one
   consumer so far, so nothing to shape one around.
2. Write `map.config.mjs` and the pages beside each other, in the directory the config's
   `pagesDir` names. Start from `example/`: `example/architecture/` shows each kind of page, and "The pages"
   below gives the format in brief.
3. Serve it. With Vite, in `vite.config.ts`: `plugins: [architectureMapPlugin("<path to map.config.mjs>")]`,
   imported from `tools/architecture-map/vite-plugin.mjs` (dev only; a build never includes it). Without Vite,
   `node tools/architecture-map/serve.mjs <config> [port]`. The viewer is at `/architecture/`.
4. Add a check script: `"check:architecture": "node tools/architecture-map/check.mjs <path to map.config.mjs>"`, and put it in
   the project's gate.
5. Write down for contributors what a change must update (the pages, in the same commit) and what the check can't see.

## The pages

`README.md` in the pages directory lists the top-level pages under `## The pages` as
`- [Label](page.md)`; the first is the home page. Any level page a box's `Opens` names is a child, drilled into from
that box, with a breadcrumb. Besides level pages the directory may hold:

- `journeys/index.md` and one page per journey (`nav.journeys`), `flows/index.md` and one sequence diagram per
  flow, each linked from a journey step's `Map` line;
- `dependencies.md` (`nav.dependencies`): the rules, and a table `| from | to | rule | example file |` of
  the places the code breaks them, one row per break; with a file rule, a second table
  `| file | imports | rule |`, one row per importing file and module.

A level page is a `flowchart` with at most about 12 boxes; each box is
`id["name<br/><small>role</small>"]:::kind` with a `## id` section giving a one-line sub, `Kind`, `Paths`
(backticked repo paths), `Docs`, `Machines`, `Opens`, `Breaks`, `Drift`, `See` or `Shot` items. Kinds: `person`,
`client`, `service`, `store`, `external`, `files`, `domain`, `feature`, `module`, `package`, `context`,
`group`, `note`. Arrows are `a -->|"1. sends it"| b`; numbered ones are the main path. The check lists the rest.

## The config

`map.config.mjs` default-exports a plain object. The browser imports it too, so it holds data only: no
functions, no imports. Paths are repo-relative; a glob's `*` is one path segment and `**` any depth (`docs` globs only: `coverage`, `services`, `imports.workspaces` and dependency rules take `*` alone, and the check fails on a `**` there).

| key | meaning |
|---|---|
| `title` | the viewer's title |
| `root` | the repository root, relative to the config file |
| `repo`, `branch` | "on GitHub" links: `https://github.com/<repo>/blob/<branch>/<path>` |
| `pagesDir` | the directory with README.md, the level pages, `journeys/`, `flows/` and the dependencies page |
| `tokens` | the colours. `files: [{ file, blocks }]`: the custom properties of each listed block (a block is taken when one selector in its list is in `blocks`; `@theme` takes a Tailwind `@theme` block, served as `:root`). `dark: { attribute, value }`: what the viewer sets on `<html>` for the dark theme, which a dark block's selector must match. The names `styles/page.css` uses must be among them: the check names any missing, and `example/tokens.css` defines just those |
| `services` | optional: `{ glob, page }`. Each directory matching `glob` needs a box on `page` whose Paths are inside it and whose Opens is the page named after the directory |
| `coverage` | `[{ glob, needs? }]`: each directory matching `glob` (that holds `needs`, if given) must lie under some box's Paths |
| `imports` | `{ workspaces, aliases }`: `workspaces` are globs of package directories, resolved by their `package.json` name; `aliases` are `{ prefix, within, to }` |
| `dependencies` | `{ page, rules }`, read when `nav.dependencies` is set. A rule is `{ rule, cycle: glob }` (units that import each other in a loop) or `{ rule, from: glob, to: glob }` (a unit of `from` importing under `to`; only value imports count). A unit is a directory matching the glob, named by its last segment; the `rule` text is the row's third cell. A **file rule** is `{ rule, files: dir, to: [module, …] }`: any source file under the directory `files` importing a listed module, one row per file and module, so a new file breaks the rule even when a sibling already does. A module is a package (`@scope/name`, with its subpaths), a package subpath (`@scope/name/sub`, with what lies under it) or a repo path (a directory or file; matched on where the import resolves to). Type-only imports count. Test files don't (`*.test.*`/`*.spec.*`, `.d.ts`, and directories or files named `__tests__`, `test`, `tests`, `e2e`, `fixtures`, `*test-support*`) |
| `stateMachines` | optional: `{ index, pages }`: the index page the viewer opens, and a git pathspec for every state machine page the index must list |
| `nav` | `{ journeys, machines, dependencies }`: the label of each optional section; leave one out and it is off |
| `serveSource` | default `true`: the dev server shows any tracked file. `false`: only the pages directory and `docs` |
| `docs` | globs of files shown even when `serveSource` is `false` |

## What the viewer serves

Under `/architecture/`: the engine's own files, the config, `tokens.css` (the `tokens` blocks, read from
disk on each request), and `repo/<path>`: any file git tracks, as text
(images as images), or a directory as the tracked entries under it. It reads the working-tree copy, so
uncommitted edits show; untracked files are refused except new unignored ones under `pagesDir`. Ignored
files (`.env`, `node_modules`), anything with `..` in it, and binary files are refused. `index.html` is sent
with a Content-Security-Policy (scripts only from the server and the pinned CDN), so a script inside a
rendered Markdown file does not run; `serve.mjs` also answers only to `localhost` and `127.0.0.1` on its port. `pnpm dev:funnel`-style tunnels that
publish the dev server also publish what it serves, so on a private repository set `serveSource: false`.

## What the check catches

It needs the project to be a git repository: it lists files with `git ls-files`.

Grammar (a Mermaid line the format doesn't allow, a box without its section, numbered arrows out of order,
a note linked to nothing); every path, link and `#id` resolving; every `coverage` directory under some box;
every service with its page; every journey step's map link and flow reached; flow participants being box ids;
state machine pages indexed and on a box; dependency rows matching the breaks computed from value imports
(a break with no row, a row with no break, a wrong example file), and file-rule rows matching each file's
imports, types included; every `tokens` block present, and the
viewer's stylesheet free of raw colours and of variables the token files don't define. It doesn't catch whether a box's words or an arrow is still true.
