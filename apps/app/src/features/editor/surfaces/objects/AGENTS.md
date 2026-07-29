# surfaces/objects — the second register's controls

Every verb a diagram, an image, or a code block offers in the page, plus the
lightbox they open. One surface entry (`ObjectControls`), one approach reading,
three shapes of chrome.

## Mental model

**One question, one answer: what is the writer approaching.**
`useApproachedObject` answers it for all three object kinds, from hover intent
and from the kernel's resolved context together. Two readings would be two
surfaces on screen at once, which law 4 forbids and which nobody would notice
until it happened.

**Anchors are elements, positions are derived.** A held position goes stale the
moment anything above it changes — a peer typing three paragraphs up is
enough — while the element stays itself. So hover, selection, the open
lightbox, and an open context menu all remember an element and resolve its
position on every render.

The source pane is the exception, because it diffs rather than points: what a
textarea reports is a whole string, and the base it must be read against is the
one the writer edited. That base survives local edits by mapping and cannot
survive a remote one at all (`isRemoteDocumentRebuild`), so a peer's write
either moves the fence — re-read it, keep the base — or changes the fence
itself, in which case the pane has no usable base until the next render gives
it one. Refusing there is the point: diffing a stale base against the merged
text would delete the line the peer just wrote.

**Approach is not identity.** Hover decides what the row hangs off; a menu
decides what its items act on. They are usually the same object and must never
be the same state: a right-click claims an object before hover intent has
settled on it, so a menu reading hover would run Delete on whatever the pointer
passed over last.

**Chrome shapes follow the ruling, not the node type.** Diagram and image get
`OverlayIconRow` (ruling 8: icon-only chips inside the top-right bounds, ⋮
last). A code block gets the chip cluster (ruling 15, the Notion reference):
same inside-corner physics, one card, because its language is a labeled
control and a labeled control floating alone over code reads as part of it.

## Key rules

- **The row's copy chip copies Mermaid source**, not an image (ruling 8's
  delegated call). Revision runs through the chat, so source is the bridge into
  that loop and works in every browser. Image copy and download live in the ⋮.
- **Absent beats disabled** on every menu here. A diagram that has not rendered
  has no image to hand over, so those items are not there — not greyed.
- **Every verb answers, and keeps its reason.** Copy and download reach a
  clipboard the browser can refuse and a canvas it can call tainted, so every
  one of them runs through `useVerbFeedback` and says what happened over the
  corner the writer just pressed. "The browser blocked the clipboard" and "this
  browser will not export this diagram" call for different next moves; a bare
  "try again" is the silent rejection law 5 forbids, one step quieter.
- **A textarea reports a string, not an edit.** Source editing diffs against
  what the pane RENDERED and maps the result forward, or it deletes whatever a
  collaborator typed in the meantime. `fence-draft.ts` owns that; nothing else
  may write a fence's text from a full string.
- **View state is disposable.** The viewer's pan and zoom, and a fence's
  wrapped lines, live as long as their element and no longer. Neither is
  written to the document: how one writer reads one block on one screen is not
  a collaborator's business.
- **Hover timing comes from `chrome.createHoverIntent`**, never a local timer.
  The kernel cancels it when a gesture starts.

## Anti-patterns

- Storing a document position in React state. Store the element.
- Anchoring to `view.nodeDOM(pos)` without asking what the object's rendered
  bounds actually are: an inline image's wrapper is a line box a fraction of
  the picture's height.
- Putting a control inside the viewer's gesture host. The host takes pointer
  capture on `pointerdown`, so a button in it never receives its own click.
- Rendering source in the page. The page never shows Mermaid syntax; the one
  exception (a caret inside the fence) belongs to the node view
  (`core/editor/MermaidCodeBlock.tsx`), which answers a failed first render
  with an error card rather than a fence.
- Discarding an export promise (`void copyImage(...)`). An unhandled rejection
  is a failure the writer never hears about.
- Reading the approached object inside a menu handler. Menus carry their own
  target.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`core/editor/viewer`](../../../../core/editor/viewer/AGENTS.md) — pan/zoom
→ [`features/editor/chrome`](../../chrome/AGENTS.md) — the primitives this builds from
→ design of record: `editor-toolbar-split/interaction-model.md` §5.2, §5.3, §5.6
