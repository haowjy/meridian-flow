# surfaces/objects — the second register's controls

Every verb a diagram, an image, or a code block offers in the page, plus the
lightbox and the field popover they open. One surface entry (`ObjectControls`),
one approach reading, three shapes of chrome.

**This lane owns image verbs for BOTH image nodes.** The inline `image` and the
captioned block `figure` are one surface here — alt text, Replace, caption and
label, copy, download, duplicate, delete — because they are one concept with two
node shapes. Their node views render; they do not edit.

## Mental model

**One question, one answer: what is the writer approaching.**
`useApproachedObject` answers it for all three object kinds, from hover intent
and from the kernel's resolved context together. Two readings would be two
surfaces on screen at once, which law 4 forbids and which nobody would notice
until it happened.

**Elements are geometry, holds are identity.** Hover, selection, the open
lightbox, and both context menus remember a `NodeHold`
(`core/editor/anchors.ts`) and resolve it to the current node and the current
DOM on every render. Neither a raw position nor an element can be the memory: a
position goes stale the moment anything above it changes, and an element belongs
to a node view that any rebuild may replace. `useNodeHold` carries the hold
through every transaction and lets go once the object is gone, which is what
closes the surface — no state here outlives the thing it points at.

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

**Nothing here names an object type.** Which objects this surface serves is
`EDITOR_OBJECT_TYPES` filtered by `surfaceKind`; what a diagram's verbs are
called and how its picture exports comes from its provider row
(`core/editor/diagrams`); which fields a ⋮ can edit comes from the row's
`surfaceFields`. A new object kind — a new diagram provider included — reaches
this lane as data, which is what "one row plus its renderer" means downstream.

**Chrome shapes follow the ruling, not the node type.** Diagram and image get
`OverlayIconRow` (ruling 8: icon-only chips inside the top-right bounds, ⋮
last). A code block gets the chip cluster (ruling 15, the Notion reference):
same inside-corner physics, one card, because its language is a labeled
control and a labeled control floating alone over code reads as part of it.
Both shapes cap at one line of the text they decorate (human ruling), so every
control in them is the dense `xs` button size.

**Two rungs of the claim ladder land here.** `object` is a right-click on a
diagram, an image, or a figure and opens the ⋮ it already has. `caret` is a right-click
INSIDE a plain fence and opens the fence's verbs as one list (human ruling,
2026-07-29). A plain fence is not an object — clicking it places a caret — so
its rung is the ladder's floor rather than the object rung.

## Key rules

- **The row's copy chip copies the diagram's source**, not an image (ruling 8's
  delegated call), and the provider's name is what the label spells. Revision
  runs through the chat, so source is the bridge into that loop and works in
  every browser. Image copy and download live in the ⋮.
- **An object's own words are written straight through, in a popover.** Alt text,
  a figure's caption, and its label are attributes every peer can see, so
  `ObjectFieldPopover` dispatches one `setNodeMarkup` per keystroke rather than
  holding a draft behind a Save button. The ⋮ item the writer picked decides
  which field takes the caret; the popover shows every field the registration
  declares, so a figure reaches its label without going back to the menu.
- **Replace is offered whether or not there is a project**, and refuses out loud
  when there is not: the ingress lane already says "Images need a project before
  they can be uploaded", and a ⋮ whose shape changes with the document teaches
  nothing. It reuses the ordinary upload lifecycle on the slot that is already
  there, so nothing is inserted or removed and undo takes it back in one step.
  The picture is HELD as the picker opens (`holdNode`), because the writer is in
  front of an operating-system dialog while the document keeps moving.
- **Reset size is the way back down the escalation ladder**, and the only door
  to it once the drag has left the writer's undo stack. It is offered only to a
  picture that carries a width, which is the absent-beats-disabled rule below
  read on an attribute. The grips themselves belong to the picture's node view,
  not to this surface (`core/editor/images`): a drag on the object's own bounds
  is direct manipulation, and it needs the element per frame rather than a hold
  per verb.
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
- **A fence's verbs live in `fence-menu-items.tsx`, once.** The chip cluster
  spreads them across three controls and the right-click nests the language
  into one list; both render the same components against the same commands. A
  verb added to one door and not the other is two answers within a week.
- **Hover targeting comes from `chrome.registerHoverAnchor`**, never a local
  timer or pointer listener. The kernel owns one hover owner at a time,
  re-hit-tests a stationary pointer after scroll, and cancels when a gesture
  starts.

## Anti-patterns

- Storing a document position, or an element, as what a surface is aimed at.
  Store a hold; read geometry per frame.
- Anchoring to `view.nodeDOM(pos)` without asking what the object's rendered
  bounds actually are: an inline image's wrapper is a line box a fraction of
  the picture's height.
- Putting a control inside the viewer's gesture host. The host takes pointer
  capture on `pointerdown`, so a button in it never receives its own click.
- Rendering source in the page. The page never shows a diagram's syntax; the one
  exception (a caret inside the fence) belongs to the node view
  (`core/editor/CodeBlockNodeView.tsx`), which answers a failed first render
  with an error card rather than a fence.
- Editing a node's attributes from its node view. Alt text, caption, and label
  are verbs on this surface; a form in the node view is a second owner and
  permanent furniture in the manuscript.
- Discarding an export promise (`void copyImage(...)`). An unhandled rejection
  is a failure the writer never hears about.
- Reading the approached object inside a menu handler. Menus carry their own
  target.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`core/editor/viewer`](../../../../core/editor/viewer/AGENTS.md) — pan/zoom
→ [`features/editor/chrome`](../../chrome/AGENTS.md) — the primitives this builds from
→ design of record: `editor-toolbar-split/interaction-model.md` §5.2, §5.3, §5.6
