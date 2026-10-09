# core/editor/links — the link system, headless

What a link means, what pressing one does, and which surface is open. React
lives in [`features/editor/surfaces/link/`](../../../features/editor/surfaces/link/AGENTS.md),
and following a link (scope, resolver, outcomes) is
[`features/links/`](../../../features/links/AGENTS.md); nothing here renders.

## Mental model

**One classifier, three kinds.** A link is a standard Markdown link to an
address. `classifyLinkTarget` turns an href into `scheme | relative |
external`, and every consumer reads that one answer: the click, the hover
hint, the menu, the mark's own rendering, the paste sanitizer. The first two
are the *internal family* — a Context URI or a path relative to the holder,
one behavior — and are asked about as `{ ref, href }` with the classifier's
own spelling (`linkTargetHref`). `external` is the client's alone and never
crosses the resolution port. A link mark's identity is read only through
`linkKeyOfMark`, and cached only under `linkCacheKey`. There are no wikilinks:
`[[name]]` is text. Only a paste into an Editor document converts it, to a
standard link (`WikilinkPasteExtension`, which the Editor alone mounts); paste
without formatting and a destination in code keep the characters, and an
escaped `\[[` stays the literal brackets.

**Following is a decision, then a destination.** `linkClickIntent` decides
whether a press follows or places the caret, and where a follow goes;
`followLink` sends an external target to a new tab and an internal one to a
navigator the app registers. No navigator is a real state, not a bug — the
click falls through to the caret and the menu omits Open link rather than
offering a dead verb.

**Which chip a link draws is a rule here, not a style.** `linkChip()` maps a
target and its resolution answer to a state (filled, or dashed when nothing is
at that address or the document it named is gone) and a family icon name; every surface emits its
attributes (the Editor on the decoration spans inside its `<a>`) and the look
lives in
[`components/app/link-chip/`](../../../components/app/link-chip/AGENTS.md).
Core names families and imports no icons.

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
  the UI renders, never a failure it reports. Addresses are unique, so there
  is no "several documents" state. A request that *failed* is a further
  thing: no answer at all, rendered as an ordinary link.
- **Invalidation is a registration, and a registration is a generation.**
  Registering the port starts a generation that owns its answers, its one
  question per link key (ref and href), its queue, and its in-flight counter; a question settles
  against the generation that asked it, never against whatever is waiting under
  that href now. The app registers again when the scope or the project's
  document catalog changes, so there is no
  `refresh`-shaped verb to call and no reason for a mutation site to reach in
  here. A question a click waits on
  (`resolve()`) is carried into the next generation and asked again; one only
  the decorations asked is dropped with its generation.
- **A link names a document; no resolution is ever stored.** The mark stores
  a `ref` (`doc:`/`ahead:`) beside its href, and every producer assigns it through
  `link-assignment.ts` without parsing or waiting on the network. Where the
  document is now, and whether the reader can reach it, rides a decoration
  keyed by ref and href (law 9), so no peer receives an answer that was true
  in someone else's project. A move writes nothing into linking documents.
- **A picture's ref is a link's question.** An `image` or `figure` with a ref
  is answered by this cache under the same key (`pictureKeyOfNode`), asked by
  the same document scan; its node view draws the answer. No second cache.
- **The decorations are mapped on an ordinary keystroke and rebuilt only when
  something reached a link** — a mark step, an edit inside one, an answer
  landing. The exception is a remote write: mapping across the whole-document
  replace reports every position deleted and would erase the drawing, so
  `isRemoteDocumentRebuild` rebuilds instead.
- **A copied link keeps its document.** The clipboard records each internal
  link's current address, ref and project; a paste in the same project keeps
  the ref and any other assigns the address fresh (`link-clipboard.ts`).
  Ref-bearing images and figures travel the same way. Never
  paste a relative href into a different holder as written, and never trust
  clipboard metadata as a capability.
- Register keys and claims from the plugin's `view()`, never TipTap's
  `onCreate` — it fires a macrotask late and the first Ctrl+K misses it.

## Anti-patterns

- A second normalizer for writer input, or a second scheme list.
- A cache-poking call at a mutation site. Whatever changed the project changed
  the document catalog, and the catalog is what the resolution scope watches.
- A surface reaching past the store into `editor.storage`.
- Gating an AI write on link validity. Marks inform; nothing approves.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — the seam, the behavior matrix,
  the resolution port, and how a state nobody stored gets drawn
→ [`../extensions/at-reference/AGENTS.md`](../extensions/at-reference/AGENTS.md) —
  the Editor's `@`, the one way a writer inserts one of these links
→ [`../chrome/AGENTS.md`](../chrome/AGENTS.md) — the kernel this registers with
