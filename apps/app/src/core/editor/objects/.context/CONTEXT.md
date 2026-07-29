# Object physics — contracts

Reference depth for the second register. Read [`AGENTS.md`](../AGENTS.md)
first, and the kernel's
[`.context/CONTEXT.md`](../../chrome/.context/CONTEXT.md) for the seams.

## Registering an object type

```ts
// object-types.ts — append-only, one row per type
{ nodeType: "figure", engage: "surface" },
{ nodeType: "code_block", matches: (node) => node.attrs.language === "mermaid",
  engage: "surface" },
```

`engage` says what Enter — and a double-click on the object — means:

| Intent | Enter does | Who performs it |
|---|---|---|
| `surface` | opens the object's own surface (the dialog) | the lane, via `registerObjectEngagement` |
| `caret-inside` | drops the caret at the first text position within | the kernel |
| `none` | nothing | nobody — but the key is still consumed |

A selected plain code fence is engaged too, and is NOT in this table: it is
prose the writer types into, so click still places a caret and the arrow walk
still steps past it. Enter takes the caret to its start (§4), because a code
block's rendering is its source and there is nothing else to open. That is why
the Enter contribution sits at `block` scope with an `appliesTo` covering both
`object` and `source-block` owners rather than at `object` scope.

`registerObjectEngagement` receives an `ObjectOpening` alongside the target:
`"engage"` for an object that already exists, `"created"` for one made a moment
ago. Law 2's sole exception is carried by that word — a new empty diagram opens
ready to work — and only the lane owning the surface can act on it, so the
physics reports the reason instead of deciding.

Both doors run the same registration: `handleDoubleClickOn` selects the object
and then calls the identical `engage`, so a lane wires its surface once (§5.2's
"click 2 / double-click / Enter opens the dialog"). A double-click in prose is
left to the browser's word selection.

An engagement is also told WHY it is opening, because law 2's exception turns
on exactly that:

| `opening` | Who says it | What the surface owes |
|---|---|---|
| `engage` | Enter, double-click | show what is there |
| `created` | the lane that just made the object | open ready to work — there is nothing to view yet |

A surface free to ignore it still gets the argument, so the reason never has to
be smuggled through a second channel.

`ObjectEngagement` returns `void`, and that is the contract rather than an
omission: Enter is consumed either way, so a handler has nothing to decide. A
`surface` row with no registered handler is therefore a dead key, which law 5
forbids on anything shipped — legal only while its lane is unbuilt, and it
warns in development so it is found by a developer rather than by a writer
pressing Enter on a diagram.

`matches` narrows a node type that is only sometimes an object. Everything
else — selection, arrow-walk, Esc, the resolved chrome context — follows from
the row with no further per-type code.

## Registering behavior from a lane

```ts
useEffect(() => registerObjectEngagement(editor, "figure", ({ node, pos }) => {
  openDialog(pos);
}), [editor]);

useEffect(() => registerObjectKeymap(editor, "code_block", {
  "Mod-Enter": () => { openDialogWithSource(); return true; },
}), [editor]);
```

Engagements are keyed by node type, so a type that is only sometimes an object
gets the whole node and decides for itself. `registerObjectKeymap` registers at the kernel's `object` scope with an
`appliesTo` on the node type, so the binding runs only when that type is the
selected object and does not re-check the selection itself.

Both return an unregister. Both are no-ops on an editor without chrome.

## What "selected" means, per node

- **Figures, images, rules, mermaid fences**: a `NodeSelection`.
- **Tables**: a `CellSelection` covering every cell. prosemirror-tables
  normalizes a `NodeSelection` on a table into exactly that, so it is not an
  approximation — it is the only spelling available. `selectedObject` reads
  both, and `selectObjectTransaction` still dispatches a `NodeSelection`
  because the tables plugin converts it on the way in.

## When a pointer selects: press, not click

Two doors, and the difference is timing rather than taste.

`handleClickOn` is ProseMirror's own path and runs on **mouseup**. It covers
every object, and it is what a tap, a click on an image, and a click on a scene
break go through.

`selectObjectUnderPress` runs on **mousedown**, and only when the press landed
on something marked `contenteditable="false"` inside an object. That case needs
the earlier door because the browser answers a press before mouseup: pressing a
non-editable element sends it hunting for the nearest editable position, and
inside a node view that hides its own text — a rendered mermaid fence — the
nearest one is that hidden text. The caret landed there, the node view brought
the source back to keep those keystrokes reachable, the page moved under the
pointer, and the mouseup landed in the source it had just revealed. Past the
click slop ProseMirror hands the press to the browser entirely and
`handleClickOn` never runs at all, so the source simply stayed.

Two things make this a rule rather than an exception:

- **The test is the DOM's, not a node type's.** An object body that refuses a
  caret takes the press. A plain fence and a table cell are editable and are
  untouched, which is what keeps §5.3's "a click in code places a caret".
- **It is a plain listener on `view.dom`, not `handleDOMEvents`.** ProseMirror
  reads a prevented default from a `handleDOMEvents` hook as "the plugin owns
  this press" and skips its own mouse machinery — the machinery that counts
  clicks and turns the second one into a double-click. This has to run beside
  that machinery, never instead of it.

Refusing the default is the whole mechanism: nothing later can take a caret
back, so it must never be placed.

## The ring is a decoration, not a lifecycle call

`SELECTED_OBJECT_CLASS` is painted by a ProseMirror decoration derived from the
selection on every view update. It deliberately does NOT use ProseMirror's own
`ProseMirror-selectednode`.

That class is applied once, imperatively, by a node view's `selectNode`
lifecycle call. A remote write never goes through it: y-prosemirror rebuilds
the document from the Yjs type rather than applying the peer's steps, the node
views are replaced under a selection that never changed, and nothing tells the
new one it is selected. The ring vanished on a peer's first keystroke and did
not come back on re-selecting — only on a reload. A decoration has no lifecycle
to miss, so a rebuilt view is constructed already holding the class.

Anything else that has to survive a peer's write belongs in the same place. If
you find yourself reaching for a node view's lifecycle hook to mark editor
state, that is the shape of this bug.

## The walk

`objectBeside(state, direction)` answers "what would the caret walk onto",
with two neighbourhoods checked in order:

1. an inline object beside the caret inside the same text block (an image);
2. the immediate sibling block, but only when the caret is at the very edge of
   its text block.

The immediate neighbour is what "beside" means: a paragraph next door ends the
walk rather than hiding an object two blocks away behind it. No sibling at this
depth means the edge belongs to the level above, so the walk climbs (the last
paragraph of a list item shares its edge with the list).

`walk()` in the extension is then two cases: an object is selected, so pass
beyond it; or the caret is beside one, so step onto it. Anything else returns
false and the editor's own caret movement stands.

Esc's forward search has three rungs, tried in order: a text position (a
caret in prose), then a gap cursor past whatever leaves follow, then — only
when nothing lies ahead at all — behind the object. `GapCursor.findFrom` is
not what finds the gap: it stops dead at a selectable node, so from just after
a diagram it sees the scene break next door and reports nothing, which is how a
trailing leaf sent the caret backward over the object. The gap the writer wants
is on the FAR side of that leaf.

**Esc does not reuse the arrow walk.** They ask different questions, and
conflating them once sent the caret backward. `caretBesideObjectTransaction` is
the arrow's: strictly the position immediately beside the object, null when
that side is a dead end, so a leaf sitting against the object is something the
next arrow press steps ONTO. `caretHomeFromObjectTransaction` is Esc's: the
first position forward where the writer can type, stepping OVER a leaf that
holds no text — leaving object-land should not land on another object with the
next keystroke poised to replace it. Only when nothing lies ahead does it look
behind.

The arrows register at `block` scope, not `object`. Walking onto an object
begins in the prose beside it, where nothing is selected yet, so an `object`
scope would filter out the first press of the two. Only Enter is `object`.

## Known gap for the table lane

`caret-inside` on a table lands in the first cell, which is right. What has no
kernel answer yet is the reverse: no gesture here *selects* a table — arrowing
to a table's edge selects it via `selectObjectTransaction`, but the block
handle (M9) and the grips (M6) will want their own entry points, and both land
on the `CellSelection` spelling above. Neither lane needs a kernel change; both
should call `selectObjectTransaction` rather than building a second spelling.
