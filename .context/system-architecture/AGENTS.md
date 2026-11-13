# Architecture map

The map is the Markdown pages here, one Mermaid diagram each; [README.md](README.md) lists
them, says how to edit them (**a change to what the map names, or to a writer journey, updates the
page in the same commit**) and what `pnpm check:architecture` catches and doesn't. Read it before
editing a page. The check passing is not the test.

## Content here, engine in `tools/architecture-map`

This directory is Meridian's content: the pages and `map.config.mjs`. The viewer, the
check and the dev server are the reusable engine in [tools/architecture-map](../../tools/architecture-map/AGENTS.md):
read its AGENTS.md before changing how the viewer or the check works, and keep project names out of it. Anything
that varies by project goes in `map.config.mjs`, a plain object the browser imports too (no functions).

- A change to the rules the check enforces for Meridian (a coverage glob, a dependency rule, an alias, nav
  labels, `serveSource`) is an edit to `map.config.mjs`. A new directory pattern that must be covered is a
  `coverage` entry; a new dependency rule is a `dependencies.rules` entry plus its rows on `dependencies.md`.
- The viewer's colours are `packages/design-tokens`, read when the viewer loads (the config's `tokens`):
  a token change shows in the map with nothing to copy.
- `pnpm dev` serves the viewer through the engine's Vite plugin (registered in `apps/app/vite.config.ts`). It
  serves any git-tracked file at `/architecture/repo/<path>` for the viewer's links; `pnpm dev:funnel`
  publishes that too, which is fine while the repo is public. If it becomes private, set `serveSource: false`.
- Routes, the Read | Map views and the doc view are described in the engine's AGENTS.md.
