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
enough — while the element stays itself. So hover, selection, and the open
lightbox all remember an element and resolve its position on every render.

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
- **A verb that can fail says so where the writer is looking.** The copy chip
  wears its answer (a check, or a warning with the reason in its tooltip) for
  a moment and goes back to being a verb.
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
- Rendering source in the page. The page never shows Mermaid syntax; the two
  exceptions belong to the node view (`core/editor/MermaidCodeBlock.tsx`).

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`core/editor/viewer`](../../../../core/editor/viewer/AGENTS.md) — pan/zoom
→ [`features/editor/chrome`](../../chrome/AGENTS.md) — the primitives this builds from
→ design of record: `editor-toolbar-split/interaction-model.md` §5.2, §5.3, §5.6
