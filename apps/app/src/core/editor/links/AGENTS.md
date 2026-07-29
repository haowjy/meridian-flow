# core/editor/links — the link system, headless

What a link means, what pressing one does, and which surface is open. React
lives in [`features/editor/surfaces/link/`](../../../features/editor/surfaces/link/AGENTS.md);
nothing here renders.

## Mental model

**One classifier, four kinds.** `classifyLinkTarget` turns an href into
`wikilink | scheme | relative | external`, and every consumer reads that one
answer: the click, the hover hint, the menu, the mark's own rendering, the
paste sanitizer. The first three are the *internal family* — three spellings,
one behavior (§5.5) — and are exactly the server's `DocumentLinkTarget`, so
`documentLinkTarget()` is a projection, not a translation. `external` is the
client's alone and never crosses the resolution port.

**Following is a decision, then a destination.** `linkClickIntent` decides
whether a press follows or places the caret, and where a follow goes;
`followLink` sends an external target to a new tab and an internal one to a
navigator the app registers. No navigator is a real state, not a bug — the
click falls through to the caret and the menu omits Open link rather than
offering a dead verb.

**The store is the surface policy.** `link-surface.ts` holds which link is
being approached and which of the two summoned surfaces is open;
`LinkSurfaceExtension` is the only thing that reads the document, watches the
pointer, and calls into it.

## Key rules

- **A new link spelling is added to `classifyLinkTarget` and nowhere else.**
  A consumer that pattern-matches an href itself is the drift this module
  exists to prevent.
- **The classifier is also the security fence.** An href outside both families
  is `null`, and null means no hint, no follow, no Open verb, and no rendered
  destination. `MeridianLink` asks it on parse, on command, and on render,
  because the markdown parser is a third door into the document.
- **A link in the manuscript never navigates the browser.** The plugin cancels
  that unconditionally, on `click` and `auxclick` alike; what happens instead is
  this module's decision. A follow also puts the selection back where the press
  found it — reading a link is not moving the writer's place.
- **A surface that outlives a keystroke holds a `LinkAnchor`, never raw
  positions.** Every remote write rebuilds the whole document, so ProseMirror's
  mapping has nothing to say about where anything went; Yjs relative positions
  do. And position alone is never enough: re-read the mark and compare it, or
  the surface acts on whatever slid into the coordinates.
- **Unresolved is normal, not an error.** Serial writers link chapters before
  they write them, so an internal target that resolves to nothing is a state
  the UI renders, never a failure it reports.
- Register keys and claims from the plugin's `view()`, never TipTap's
  `onCreate` — it fires a macrotask late and the first Ctrl+K misses it.

## Anti-patterns

- A second normalizer for writer input, or a second scheme list.
- A surface reaching past the store into `editor.storage`.
- Gating an AI write on link validity. Marks inform; nothing approves.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — the seam, the behavior matrix,
  and what the wikilink lane plugs into
→ [`../chrome/AGENTS.md`](../chrome/AGENTS.md) — the kernel this registers with
