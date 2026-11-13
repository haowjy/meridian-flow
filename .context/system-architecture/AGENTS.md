# Architecture map

How the system is built, as a diagram you can click into, with the state machines drawn on the
same page. Open it from the URL `pnpm dev` prints (`map`, ending `/architecture/`), or open
`index.html` from disk: the map works there, but state machine pages are fetched from the repo,
so a page opened from disk says so and links the file instead.

## Editing

- **The content is `architecture.js`.** Its header comment is the schema: levels, boxes, arrows,
  and a box's `machines` (the repo paths of the `state-machines.md` pages for its code). Nothing
  else holds map content; `js/` only renders it.
- **A change that adds, moves or removes a box's code, an import between boxes, or a
  state-machines page updates `architecture.js` in the same change.**
- Every page `.context/state-machines/index.md` links must be on a box, and every
  `.context/**/*state-machine*.md` must be linked from that index. A new state machine page
  lands in the index, then on a box.
- **`pnpm check:architecture`** (part of `pnpm check`) fails on a malformed map, a path that
  doesn't exist, a page that is on no box, an unindexed page, a design token that drifted from
  `packages/design-tokens`, and a raw colour or undefined variable in `styles/page.css`. It does
  not know whether the words are still true; that stays with review.
- The map's source may move to Markdown; check `git log` here before building on the React Flow
  parts (`js/diagram.js`, `js/layout.js`, `js/node-card.js`).

## How it works

- No build step. Classic scripts set globals (`globalThis.ArchMap`); `js/model.js` has no DOM, so
  `check.mjs` runs the page's own `validate`.
- **State machine panel** (`js/doc-view.js`): fetches `<repo path>`, renders it with `marked`, draws
  every ` ```mermaid ` block with Mermaid (pinned to the version in `apps/app/package.json`, loaded
  on first use). A relative link to a `.md` under a `.context/` directory opens in the panel;
  any other relative link goes to the file on GitHub. The open page is the `?doc=` parameter.
- **Tokens:** `styles/tokens.css` mirrors the values it uses from `packages/design-tokens`
  (the light palette sits in a Tailwind `@theme` block a browser ignores). To use another token,
  add its name to `MIRRORED` in `tokens.mjs` and its value to `tokens.css`; `check.mjs` verifies
  the values. Page CSS holds no colour of its own.
- **Dev serving:** `apps/app/dev/architecture-dev-plugin.ts` serves this directory and every
  `.context/**/*.md` at their repo paths, only under `pnpm dev`; a production build has none of it.
- Third-party scripts are pinned with integrity hashes: in `index.html`, and Mermaid in
  `js/doc-view.js`. To bump one, fetch the new file and recompute its `sha384`.
- Screens: a box's `shot` is read from `docs/screens/screens.js` when that file exists. Nothing
  generates it yet.
