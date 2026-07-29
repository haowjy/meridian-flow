# Chrome kernel — the seams six surface lanes build on

Reference depth for the headless kernel. Read [`AGENTS.md`](../AGENTS.md)
first. Everything below is a contract a lane can rely on without asking.

## The four append-only seams

| # | Seam | File | What a lane adds |
|---|---|---|---|
| 1 | Extension registration | [`core/editor/config.ts`](../../config.ts) → `EDITOR_CHROME_EXTENSIONS` | one line, at the placeholder comment for its lane |
| 2 | Chrome mount host | [`features/editor/chrome/chrome-surfaces.tsx`](../../../../features/editor/chrome/chrome-surfaces.tsx) → `EDITOR_CHROME_SURFACES` | one entry, `{ id, render }` |
| 3 | Keymap contributions | `chrome.registerKeymap(...)` at a named scope | a runtime registration, no new extension priority |
| 4 | Stylesheet | a `.css` file beside the lane's own component, imported by it | its own file; `features/editor/editor.css` is the document's, not a lane's |

Nobody edits `EditorView.tsx`. Nobody edits another lane's stylesheet. A
rebase between lanes is then two files rather than two hunks in one.

Object types are a fifth list with the same discipline:
[`objects/object-types.ts`](../../objects/object-types.ts) → `EDITOR_OBJECT_TYPES`.

## Getting the kernel

```ts
const chrome = getEditorChrome(editor); // null on an editor without chrome
```

Null is a real state (the code-schema surface mounts no chrome), not a bug.
React reads it through `useEditorChrome` / `useChromeContext` /
`useChromeSuppressed` in `features/editor/chrome/`.

## Layers and the Esc chain

A surface that is open registers a layer; the kernel closes the topmost one
first. `chrome.layers` is ordered by NESTING, shallowest first, so the last is
topmost.

```ts
const handle = chrome.openLayer({
  id: "diagram-source",
  parentId: dialogLayerId, // the layer this one opened inside
  dismissal: "kernel",     // default; "self" for anything Radix-backed
  close: () => setOpen(false),
});
handle.release(); // when the surface has closed itself
```

**One transient at a time, enforced here.** A layer opened with no `parentId`
REPLACES every open top-level layer and their subtrees: law 4 is the kernel's
to keep, not something each surface remembers to do on its way in. Leaving it
to surfaces let the slash menu and the link form both stay live, two inputs
reading the same keystrokes. A layer that names a `parentId` is not a rival —
a submenu, a dialog's source pane — and is left alone.

**Depth is not arrival order.** React mounts child effects before parent
effects, so a dialog that opens with its source pane already showing registers
the pane first — and that is the design's mandated new-empty-diagram path, not
an edge case. Read as a stack it would make the dialog topmost and spend both
steps of the walk home on one key. `parentId` is what fixes it; the React hook
fills it from context and a surface only has to wrap its children in
`layer.scope(...)`.

**Asking to close is once.** `closeTopLayer()` marks the layer out of the walk
before calling its `close`, so a dismissal that never lands costs one Escape
rather than every Escape after it. The surface may still be on screen finishing
its exit; the chain has simply stopped offering it the key. That trades away a
tidier property — Esc mashed during an exit animation used to stall on the
closing surface — because "nobody is ever trapped" outranks it.

`close` and the surface's own dismissal must be the same path. The kernel calls
`close`; the surface's close path calls `release`.

`escStep` decides one step, in this order:

1. a drag or sweep in flight → cancel it (the owner's `onCancel` runs)
2. any layer open → close the topmost
3. the selection is on an object, or a caret is in a source block → caret past it
4. the caret is in prose INSIDE an object (`context.objectPos`) → select that
   object
5. otherwise `at-home`, and the key is left unhandled

Law 3's three-step walk (source → object selected → caret after) is not three
cases: a diagram's source pane is a layer inside its dialog, so step 2 runs
twice and step 3 once. Verified end to end in the browser.

Step 4 is the same walk for an object whose insides are prose. A caret in a
table cell is standing inside the table, so Esc selects the table and only the
next Esc leaves it — which is also the keyboard route to the table's object
controls (M6). `resolveChromeContext` carries the position of the nearest
enclosing object as `objectPos` because nothing else in the ancestor walk keeps
a position the chain could recover later.

**Radix subordination (verdict: KEPT, 2026-07-29).** Radix owns its own
dismissal and the kernel owns the policy. Two mechanisms make that work:

- an open Radix surface registers a layer with `dismissal: "self"`, so the
  chain knows it exists and knows not to dismiss it itself;
- `useChromeLayer` returns an `onEscapeKeyDown` every Radix content must
  carry. Radix dismisses from a document listener and cannot see a non-Radix
  layer opened inside one, so without it a single Esc closes the diagram
  dialog AND the source pane inside it — two steps of the walk on one key.
  The handler makes Radix defer while the kernel's topmost layer is not it.

The pre-decided floating-ui fallback was not needed: pointer positioning works
through a zero-size anchor (`pointer-anchor.ts`), Radix menus open
synchronously from inside `contextmenu`, and exclusivity holds under rapid
context switches.

### Where Escape actually comes from

The chain is one policy with three doors, and a lane needs to know which one
its surface is behind.

| Focus is | Who delivers Escape | What the layer must declare |
|---|---|---|
| in the prose | ProseMirror's `handleKeyDown` | anything |
| inside a Radix surface | Radix's own document listener | `dismissal: "self"` plus `onEscapeKeyDown` |
| anywhere else (a hand-rolled portal, the chat composer, a toolbar button) | the kernel's document backstop | `dismissal: "kernel"` — the default |

The backstop exists because the first two doors both have blind spots: a layer
whose surface is neither focused prose nor a Radix layer would otherwise
survive every Escape, and "nobody is ever trapped" would be false without
anything looking broken. It stands aside for `"self"` layers so one key never
closes two surfaces.

A surface that declares `"self"` and does not actually listen is the one way
to reintroduce the trap. If in doubt, leave the default.

## The context-menu claim table

Handlers register against a rung of `CONTEXT_CLAIM_ORDER`:
`link` → `text-selection` → `grip` → `object` → native. First registered
handler at the strongest matching rung wins; `null` means the browser keeps
its menu.

```ts
chrome.registerContextClaim({
  id: "link",
  claim: (target) => {
    if (!target.element.closest("a")) return false;
    openLinkMenu({ x: target.event.clientX, y: target.event.clientY });
    return true;      // synchronous. Deciding late is deciding nothing.
  },
});
```

`ContextClaimTarget` carries:

- `element` — the deepest DOM element under the pointer
- `docPos` — document position under the pointer, or null outside the prose
- `context` — `chromeContextAt(doc, docPos)`, i.e. what the POINTER is over,
  not what the selection is in
- `insideTextSelection` — `proseSelectionCovers`: the pointer sits inside a
  selection that holds prose the writer could format. Not "a selection
  exists". A selection three paragraphs away is not what the writer is
  pointing at, and shadowing the native menu there would spend spellcheck on
  nothing. Nor is every non-empty range prose: a `CellSelection` over a whole
  table and a `NodeSelection` on a figure both have `empty === false`, and
  since the formatting rung outranks the object rung, counting them would put
  the formatting menu over every table and every object. `AllSelection` does
  count — Ctrl+A then format the chapter is the gesture the rung exists for.

**Where the router listens.** A capture-phase `contextmenu` listener on the
document, acting on targets inside ProseMirror's DOM and on chrome that carries
this editor's own mark.

It is capture rather than ProseMirror's `handleDOMEvents` because that prop
cannot see a right-click inside a node view at all: TipTap's
`NodeView.stopEvent` returns true for `contextmenu`, and ProseMirror consults
it in `eventBelongsToView` BEFORE running any handler. Every React node view in
this editor — `image`, `figure`, `jsx_leaf`, `jsx_container` — is one of those,
which is to say the two object types ruling 11 is about. Capture reaches them
all, current and future, with no node view having to cooperate.

Chrome that portals OUT of the editor spreads `editorChromeAttributes(chrome)`
onto its root, or its right-clicks go straight to the browser. The mark carries
the chrome's id, because two documents open side by side are two kernels
listening on one page and an unqualified mark hands one editor's overlay row to
both. `OverlayIconRow` already does this.

**`target` is an `Element`, not an `HTMLElement`.** A mermaid diagram is SVG
and so is every icon glyph in an overlay row; both are exactly what a writer
right-clicks. `closest()` works either way.

**The whole press belongs to the ladder, release included.** The kernel's
`handleDOMEvents.mousedown` returns true for any button but the primary one,
which is how a plugin tells ProseMirror to skip its own mouse machinery for
that event. ProseMirror arms that machinery on every button and runs the full
click path on the matching release — `handleClickOn`, then its own
`selectClickedLeaf`. On a right-click the release arrives after the ladder has
already opened the claimed menu, and selecting a node there syncs the selection
back into the editor, takes focus out of the menu, and dismisses it. Whether
the release beat the menu's first paint decided whether the writer saw a menu
at all: a quick right-click on a diagram showed nothing, a held one worked.

Returning true refuses no default, which is what keeps ruling 11 whole:
`contextmenu` is raised from the press on Linux and macOS and from the release
on Windows, and both still reach the router.

**`grip` before `object`.** The design groups them ("object/grip"); they never
both match, because a grip is chrome and an object is a node. Grip is spelled
first as the more specific of the two.

**`cell-selection` is last.** A rectangle of table cells the writer swept is
the widest thing on the ladder, and nothing above it wants it: the formatting
rung admits `TextSelection` and `AllSelection` only, a grip is chrome rather
than a cell, and no object type answers for a table. Without the rung a swept
rectangle reached no menu at all. Last is also correct: a link inside a
selected cell is still a link.

**The other two triggers are the claiming lane's.** §5.1 gives the formatting
menu three doors — right-click, Menu key / Shift+F10, and long-press on touch.
Only the first is a `contextmenu` event, so only the first routes here. The
keyboard twin is a keymap contribution and the long-press is a pointer timer;
both should end in the same open call the claim handler makes, so the surface
has one entry point rather than three.

## Deepest-context resolution

`resolveChromeContext(state)` → `{ owner, nodeType, pos, chain }`, recomputed
on every selection or document change and cached on `chrome.context`.

| Where the selection is | `owner` | `chain` |
|---|---|---|
| prose caret or text selection | `document` | `[document]` |
| caret in a table cell | `table-cell` | `[document, table, table-cell]` |
| caret in a plain code fence | `source-block` | `[document, source-block]` |
| a selected figure, image, rule | `object` | `[document, object]` |
| a selected or pointed-at mermaid fence | `object` | `[document, object]` |
| a whole-table cell selection | `object` (`table`) | `[document, object]` |

Two subtleties a lane will hit:

- **A table cannot hold a `NodeSelection`.** prosemirror-tables normalizes one
  into a `CellSelection` over every cell, so that — both a whole column and a
  whole row — IS how "this table is selected" is spelled here. `selectedObject`
  reads both spellings; a lane that checks `instanceof NodeSelection` itself
  will quietly skip tables.
- **A rendered mermaid fence is an object, not a source block**, even when the
  pointer resolves to a position inside it: there is no inside to point at once
  the node view renders. A table is an object too, but its cells ARE prose
  (§5.4), so it keeps its own chain.

## Keymap contributions

Scopes, deepest owner first: `layer` → `object` → `table` → `block` →
`document`. Each key runs its ladder and stops at the first binding that
returns true; returning false hands the key down, which is the difference
between "not now" and "never again".

**A scope names a place, and the kernel enforces it.** It is not a priority
number with a friendly name: a `table` binding cannot fire with the caret in a
paragraph, whether or not its lane remembered to check. Otherwise every lane
rediscovers its own guard and one missed check shadows an outer verb across the
whole document.

| Scope | Live when |
|---|---|
| `layer` | at least one transient surface is open |
| `object` | `context.owner === "object"` |
| `table` | `context.chain` contains `table` |
| `block`, `document` | always — these two are order, not place |

**`table` and a SELECTED table are different places.** A caret in a cell has
`chain` `[document, table, table-cell]`, so `table` scope is live. Selecting
the whole table makes it an object, and an object's chain is
`[document, object]` — `table` scope goes quiet and `object` scope takes over.
That is the design, not an accident: §5.4 gives Alt+Arrows to the row while the
caret is inside and to the whole block once the table is selected, so the row
verbs SHOULD fall silent there and the block verbs pick it up.

`appliesTo` narrows further, for a contribution that serves one kind of the
scope's context:

```ts
const release = chrome.registerKeymap({
  id: "object:code_block",
  scope: "object",
  appliesTo: (context) => context.nodeType === "code_block",
  bindings: { "Mod-Enter": (state, dispatch) => { /* … */ return true; } },
});
```

Pick the scope by where the key must WORK, not by what it is about. Object
physics splits for exactly this reason: walking ONTO an object starts from
prose beside it, so the arrows are `block` scope and only Enter is `object`.

Register from a ProseMirror plugin's `view()` or a React effect, not TipTap's
`onCreate` — TipTap emits `create` a macrotask late, long enough for a first
keystroke to miss it. `ObjectPhysicsExtension` shows the plugin-view pattern.

Escape is refused at registration, where the stack still names the lane that
wrote it, and the registry is left untouched so the next lane's registration
still lands. Above every scope, outside this ladder, sits
`UndoRedoKeymapExtension` at TipTap priority 1100.

## Suppression and hover intent

`chrome.suppressed` is true while a drag or sweep is in flight. Every surface
that can be on screen reads it and stands down; nothing tries to be clever
about which gesture it was. On release the kernel notifies and surfaces
re-evaluate from their own pointer state rather than reappearing where they
were — the document moved under them.

- A sweep is detected by the kernel (mousedown plus 4px of travel) and ends on
  a window `mouseup`, because the pointer leaves the editor mid-sweep
  constantly.
- A sweep also ends on window `blur` and on any `mousemove` with no button
  held. A release the window never hears would otherwise leave every surface
  suppressed with nothing left to un-suppress it.
- A surface-owned drag calls `chrome.beginDrag(onCancel)` and gets its end
  back. `onCancel` is how Esc reaches a drag the kernel did not start: without
  it the kernel could only stop suppressing, leaving a drop line chasing a
  pointer nobody is listening to.
- **Each drag owns its own end.** A second `beginDrag` cancels the first — two
  owners cannot both hold the pointer — and a late end from a replaced drag
  does nothing rather than releasing the drag the writer is running. M6's
  column resize and M9's block drag both sit on this.
- Approach chrome takes its timing from `chrome.createHoverIntent(...)`, never
  its own `setTimeout` — the kernel cancels these when a gesture starts.
  `CHROME_TIMING` holds the two numbers (`handleIntentMs` 100, `fadeMs` 120).

Hover intent is warm: once something is revealed the next thing under the
pointer answers without re-earning the delay, and leaving keeps the row for the
fade duration so the pointer can travel onto what it revealed.
