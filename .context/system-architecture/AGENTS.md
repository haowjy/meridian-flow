# Architecture map

The map is the Markdown pages here, one Mermaid flowchart each; [README.md](README.md) lists
them, says how to edit them (**a change to what the map names, or to a writer journey, updates the
page in the same commit**) and what `pnpm check:architecture` catches and doesn't. Read it before
editing a page. The check passing is not the test.

## The viewer

- `index.html` is the map, `journeys.html` the journeys. They hold no content and no colours: a page
  is fetched at its repo path, so they work only where something serves the repo (`pnpm dev` does,
  through `apps/app/dev/architecture-dev-plugin.ts`, which serves this directory and every
  `.context/**/*.md`). Production builds have none of it.
- No build step; ES modules in `js/`. `pages.js` parses a page and has no DOM, so `check.mjs`
  and the viewers read pages the same way: change the format there, in `check.mjs`, and in
  README.md together. `doc-view.js` renders Markdown and Mermaid (the `?doc=` overlay and the
  panel's collapsed pages); `map.js` and `journeys.js` are the two viewers; `shell.js` is the
  top bar and theme.
- `map.js` classes Mermaid's nodes by kind and its edges by kind (it finds an edge's elements by
  Mermaid's `data-id`, `L_<from>_<to>_<n>`; n has gaps between one pair's edges, so the k-th edge takes the k-th lowest), and styles them in `styles/page.css` from tokens. Where edge labels would not read
  at Fit (server, app, code), it lays the diagram out without them, which halves a dense level, and
  shows a box's edge labels when the box is selected and an edge's when it is hovered.
- The level list in the top bar is the `## The pages` list in README.md (`levelLinks` in `pages.js`).
- `styles/tokens.css` holds literal colour values, an exception to "no raw colors outside
  `packages/design-tokens`": the light palette sits in a Tailwind `@theme` block a browser ignores, so
  the page needs its own copy, and `check.mjs` keeps it equal to `design-tokens`. Nothing else here may
  hold a colour; `page.css` uses the variables. Don't copy the pattern. To use another token, add its name to `MIRRORED` in
  `tokens.mjs` and its value to `tokens.css`; `check.mjs` verifies the values.
- Third-party scripts are pinned with integrity hashes: `marked` in the two HTML files, Mermaid in
  `js/doc-view.js` (the same version as `apps/app`). To bump one, fetch the new file and recompute
  its `sha384`.
