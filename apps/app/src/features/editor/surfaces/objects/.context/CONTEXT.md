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

Hover comes from a single capture-phase `pointerover` listener on the document,
not on the editor: only a listener that sees where the pointer went can tell
"travelled onto the row" from "left the object". Anything matching
`[data-editor-chrome]` or a Radix popper wrapper counts as travelling onto the
chrome, so a diagram keeps its row while the writer reaches for its ⋮.

Selection persistence reads the kernel's context: `owner === "object"` is a
selected diagram or image, `owner === "source-block"` is a caret inside a plain
fence, and ruling 15 gives the second one the same persistent chrome.

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

## Known blocked

Right-click on a diagram or an image does not reach the claim ladder: TipTap's
`NodeView.stopEvent` swallows `contextmenu` before ProseMirror routes it. The
claim is registered and correct; the fix is the kernel's and arrives by merge.
Until then the ⋮ is the only door to the object menu.
