# Architecture map

The map is the Markdown pages here, one Mermaid diagram each; [README.md](README.md) lists
them, says how to edit them (**a change to what the map names, or to a writer journey, updates the
page in the same commit**) and what `pnpm check:architecture` catches and doesn't. Read it before
editing a page. The check passing is not the test.

## The viewer

- `index.html` is the only page. It holds no content and no colours: a page is fetched at its repo
  path, so it works only where something serves the repo (`pnpm dev` does, through
  `apps/app/dev/architecture-dev-plugin.ts`, which serves this directory and every `.context/**/*.md`).
  Production builds have none of it.
- No build step; ES modules in `js/`. `pages.js` parses a page and has no DOM, so `check.mjs` and
  the viewer read pages the same way: change the format there, in `check.mjs`, and in README.md
  together. `markdown.js` renders Markdown and Mermaid and turns every link into a `#` route;
  `app.js` is the router (nav, history, the Read | Map toggle, the full-window doc view);
  `map.js` is the Map view of a level page (React Flow; `layout.js` places the boxes and `routes.js`
  draws the arrows and places their labels, both without DOM); `journeys.js` is the journeys;
  `shell.js` is the DOM helper, theme and fetching.
- **Routes** are the URL hash: `#<level>[/<box>]`, `#flows[/<flow>]`, `#machines`, `#dependencies`,
  `#journeys[/<journey>[/<step>]]`, `#doc/<encoded path>[/<heading>]`. A route is a history entry, except
  choosing a box or a journey step. Opening a doc layers it over the page, so Back (the button or
  the browser's) steps back through the docs and ends on the page and box the reader came from, with the
  map's zoom and the Read scroll as they were. `history.state.docs` counts the docs opened since;
  Escape and × close them all.
- **Read | Map** is a per-reader choice kept in `localStorage`. Read is the page as Markdown; a click
  on a diagram box scrolls to its `##` section. Map is `map.js`: the intro and a "How to read this" the
  viewer supplies sit above the diagram; a group opens its child page. It does not draw the page's
  Mermaid: it draws the parsed nodes, arrows and note links with React Flow, boxes sized by their
  text. `layout.js` puts the numbered path on one row in step order, left to right (a box the path
  leaves and doesn't go on from, or comes straight back from, is a spur beside it), wraps the row
  only when it can't be drawn at `READABLE_ZOOM`, and puts every other box and note in bands above
  and below, near what it connects to. Arrows along the row run straight, skip forward over it and
  back under it. A label never covers a box or another label: a side arrow's label is left out
  where there's no room (the panel lists every arrow), and choosing a box shows its own. Fit never
  zooms below `READABLE_ZOOM` (box text 13px and 11px on screen); a level that doesn't fit, as on a
  phone, opens at its start to pan. Boxes drag and the arrows follow; positions go to
  `localStorage` per page (`meridian-architecture-layout-v2:<path>`), only when a drag ends, and a page
  whose boxes aren't all saved is laid out afresh. Read view draws the Mermaid block itself.
- A flow's participants are clickable (`resolveParticipant` in `pages.js`, shared with the check): they open the box on the map (they set the view to Map).
- `fetchRepoFile` checks the URL the browser will request, not the path string, and the doc route
  accepts only a `.context` `.md` path with no `..`, `.` or empty segment: both come from the address bar.
- The nav is the `## The pages` list in README.md (`levelLinks` in `pages.js`) plus Flows, State
  machines, Journeys and Dependencies.
- `styles/tokens.css` holds literal colour values, an exception to "no raw colors outside
  `packages/design-tokens`": the light palette sits in a Tailwind `@theme` block a browser ignores, so
  the page needs its own copy, and `check.mjs` keeps it equal to `design-tokens`. Nothing else here may
  hold a colour; `page.css` uses the variables. Don't copy the pattern. To use another token, add its name to `MIRRORED` in
  `tokens.mjs` and its value to `tokens.css`; `check.mjs` verifies the values.
- Third-party scripts are pinned with integrity hashes: React, ReactDOM, `@xyflow/react` and
  `marked` in `index.html`, Mermaid in `js/markdown.js` (the same version as `apps/app`). To bump one,
  fetch the new file and recompute its `sha384`. React stays on 18 (19 has no UMD build);
  `@xyflow/react`'s UMD build wants a `jsxRuntime` global, which `js/jsx-runtime.js` maps onto React;
  `vendor/` holds its stylesheet.
