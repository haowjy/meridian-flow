# Object controls — contracts

Reference depth for L-B. Read [`AGENTS.md`](../AGENTS.md) first; the seams are
in the kernel's
[`.context/CONTEXT.md`](../../../../../core/editor/chrome/.context/CONTEXT.md).

## What each object gets

| Object | Row / cluster | ⋮ | Enter |
|---|---|---|---|
| diagram (`code_block` + `language: mermaid`) | `[fullscreen] [copy source] [⋮]` | Edit source, Copy image, Download image, Duplicate, Delete | lightbox |
| image (`image`, `figure`) | `[fullscreen] [copy image] [⋮]` | Download image, Duplicate, Delete | lightbox |
| code block (any other language) | `[language ▾ | copy | ⋮]` | Wrap lines, Duplicate, Delete | (caret, not an object) |

Diagrams and images open their lightbox three ways: the fullscreen chip, Enter
on the selection, and a double-click in the page. The last two are the same
registration — `handleDoubleClickOn` at the object-physics seam selects the
object and runs the engagement Enter runs — so a lane wires its surface once.

A fourth opening comes from the slash lane: a diagram it just created arrives
with `opening: "created"`, and that one opens the dialog with the source pane
already showing its starter source (§5.2's law-2 exception, mockup 04's third
scene). A new diagram has nothing to look at, so the writer's first act is
typing rather than reading.

## What a diagram says when it stops parsing

Both faces show the same note, because it is the same fact: the picture on
screen is the last version that rendered, and mermaid's message names the line.
In the page it sits under the diagram; in the dialog it sits under the source.
A fence that has NEVER rendered is the one exception — there is no picture to
keep, so the source itself is revealed with the error.

## The palette

Diagrams are drawn from the design tokens, read at render time
(`core/editor/mermaid-theme.ts`), so a theme switch repaints them. Nothing in
this lane names a color.

Alt text and Replace are absent from the image ⋮ rather than dead: their
surfaces belong to the upload lane (§5.6), and law 5 prefers the gap.

The lightbox's own ⋮ is the mockup's three: Edit source / Hide source, Copy
Mermaid source, Download image. An image lightbox carries no ⋮ — its verbs are
all on the row that opened it.

## The approach reading

```ts
const { target, visible } = useApproachedObject(editor, pinned);
```

- `target` — what to anchor to and act on, or null.
- `visible` — whether it is on screen. **Separate from `target` on purpose**:
  the anchor is held for `CHROME_TIMING.fadeMs` after the writer leaves, so the
  row fades out over its object instead of blinking away from under the pointer.
- `pinned` — a menu is open on this object, so the pointer no longer decides.

Hover is the kernel's, through one `registerHoverAnchor` lane
(`core/editor/chrome/hover-anchor.ts`). This lane answers one question — which
object is at this point — and gets back its share of whichever block currently
owns hover chrome. Everything else is the kernel's: the pointer, the delay and
the grace, the re-hit-test after a scroll the writer's hand did not follow,
reading a pointer resting on this editor's own chrome as still being on the
object, and the rule that the block's grip and this row are on ONE block or the
row is not on screen at all.

Selection persistence reads the kernel's context: `owner === "object"` is a
selected diagram or image, `owner === "source-block"` is a caret inside a plain
fence, and ruling 15 gives the second one the same persistent chrome.

## Where the chrome is drawn

`target` carries two elements, and they are different questions.

- `element` — the object's rendered bounds, which the verbs read (a diagram's
  SVG, an image's `<img>`).
- `container` — the node view's own element, which is where the chrome is
  RENDERED. Absolutely positioned inside it, so a scroll or a reflow moves
  chrome and object as one piece and there is no rect that can strand.

Attachment is safe here and only here: every object in this lane is a React
node view, and a node view ignores DOM changes outside its `contentDOM`. The
manuscript's own elements are ProseMirror's, and a child inserted into one is
read back as a document change — which is why a table's ⋮ is still measured
(`chrome/object-overlay.ts` holds both cases).

## What a surface is aimed at

Three surfaces here outlive a keystroke — the lightbox and the two context
menus — and each remembers a `NodeHold` (`core/editor/anchors.ts`) taken at the
moment it opened: relative positions for where the object is, the Yjs element
for which object it is. `useNodeHold` carries it across every transaction and
answers null once the object is gone, and null is what closes the surface. So
there is no dismissal to remember to perform, and no state that can point at a
deleted diagram.

`objectSurfaceForHold(view, hold)` is the way back to the page: the hold
resolves to a position, the position to the current node and its current DOM. It
answers null for a frame in which the node view has not been rebuilt yet, and a
surface stays open on its hold through such a frame rather than closing on it.

## Resolving anchors

`objectSurfaceAt(view, target)` walks UP from whatever the pointer hit — a
diagram's `<path>`, an image itself — because the anchor is several levels
above. Each candidate is verified by asking the view for that position's DOM
back (`view.nodeDOM(pos) === element`), which is why the same code works for
React node views, schema-rendered blocks, and whatever a later lane registers:
nothing here guesses at `posAtDOM`'s off-by-one.

`renderedBounds` is the one place a node's DOM and its *visible* bounds are
allowed to differ: an inline image anchors to its `<img>`, because TipTap lays
its wrapper out as text and that wrapper's box is a line box.

## Editing source without eating a collaborator's words

A `<textarea>` reports a whole string. Diffed against the *current* document
that string is a lie the moment anyone else is typing: text a peer added since
the pane rendered was never in the writer's textarea, so the diff reads it as a
deletion and Yjs merges that faithfully.

`fence-draft.ts` holds the base the writer actually edited — what the pane
rendered — plus a `Mapping` of every LOCAL change that has landed since, and
carries the diff's offsets forward through it. With nobody else typing the
mapping is empty and this is one `insertText`. The write refuses a fence that
has been deleted or turned into another language while the pane was open:
writing Mermaid into a TypeScript block is worse than doing nothing.

A peer's write is the one thing a mapping cannot carry. It arrives as a
replacement of the whole document (see
[the position contract](../../../../../core/editor/.context/CONTEXT.md)), so
every offset in the base maps to a boundary — which is how a source pane came
to stop accepting keystrokes entirely after a peer wrote below the fence, until
something else moved the fence. `fenceRebaseAfterRemote` answers instead, by
asking whether the writer's base is still true:

- the fence's text is untouched and only its position moved: re-read where it
  sits, keep the base, and a keystroke in the same frame still applies;
- the fence's text changed underneath the writer: there is no usable base until
  the next render supplies one, and the pane refuses. Diffing the stale base
  against the merged text would read the peer's new line as the writer's
  deletion, which is the exact thing this module exists to prevent.

The rebase resets on every render that shows new document text, and again
immediately after a dispatch, so the base and the mapping can never disagree
about which version they describe.

## What a verb says back

`useVerbFeedback` runs a promise and keeps its answer; `ObjectVerbNotice`
renders it over the object's corner, `VerbNoticePill` inside the dialog where
the page's own notices are behind the scrim. Every door goes through it —
a chip, a row ⋮, the lightbox ⋮ — so no path can quietly drop a rejection, and
the two failures browsers actually produce here keep their meaning:

| Failure | What the writer is told |
|---|---|
| `NotAllowedError` | the browser blocked the clipboard, check permissions |
| `SecurityError` (tainted canvas) | this browser will not export the diagram, copy the source instead |
| `ExportError` | the image could not be read, or cannot be turned into an image |

The second one points at the door that always works, which is why the row's
copy chip carries Mermaid source rather than an image.

## The lightbox

Radix Dialog through the M2 wrapper, so it is a layer in the Esc chain. The
source pane registers a layer of its own, which is what makes law 3's walk fall
out of one rule rather than three cases:

| Esc | leaves |
|---|---|
| 1 | source pane closed, dialog open |
| 2 | dialog closed, the object selected (jade ring, row persistent) |
| 3 | caret after the block |

Step 2 needs the object *selected*, so closing the dialog dispatches the
selection — hover-opening skipped that step deliberately (§5.2: one click on
fullscreen, no selection first), and the walk home needs its middle stair back.

Source edits land as minimal patches (`minimalTextPatch`): common prefix and
suffix, so Yjs sees what the writer did instead of a delete-and-reinsert of the
whole diagram per keystroke, and a peer's caret inside it survives. The preview
follows a typing pause; a parse error keeps the last good render and shows
mermaid's message, which names the line.

## Deliberate calls

**The source pane takes focus a beat late.** Radix's dialog scope and the ⋮
menu both restore focus asynchronously on their way out, so a synchronous claim
is taken back. Measured, not guessed.

**Wrapped lines are a DOM attribute on the block, not a node attr.** The
document says nothing about how one writer reads one fence on one screen. It
lives exactly as long as the rendered block, which is the lifetime the diagram
viewer's pan and zoom get.

**Fit never enlarges a raster past its natural size** (`maxFitScale={1}` on the
image face). A vector diagram is happy filling the frame; a photograph
enlarged to fill it is just bigger pixels.

**Text inside a code block stays selectable.** The chips are chrome floating
over the corner; only the diagram viewer's canvas claims the pointer, and it
claims it because drag pans there (§5.2).

## Opening a dialog from a closing menu

A surface opened by a menu item has a known way of dying: the menu's close
hands the caret back to the prose, TipTap's focus command lands a frame later,
and a *non-modal* Radix surface reads that late arrival as an interaction
outside itself and dismisses. The lightbox does not, because it is modal —
Radix traps focus and ignores what happens beyond the scrim. Probed four times
from ⋮ → Edit source with a 100 ms read inside the failure window: open every
time.

`useChromeLayer`'s `onCloseAutoFocus` carries both halves of the guard: it
stands down when a successor layer is still open, and when the manuscript is
behind a modal scrim (`aria-hidden` / `inert`).

## Right-click

Claimed at the `object` rung, and only for diagrams and images: a code block's
right-click stays the browser's, so spellcheck and paste survive inside a
fence. The claim remembers the ELEMENT it claimed, not the hovered one, and
selects the object so the menu says what it is about.

(The kernel's capture-phase router landed with the editor-core merge; before
it, TipTap's `NodeView.stopEvent` swallowed `contextmenu` and this claim never
ran.)
