# Chrome kernel — the seams six surface lanes build on

Reference depth for the headless kernel. Read [`AGENTS.md`](../AGENTS.md)
first. Everything below is a contract a lane can rely on without asking.

## The four append-only seams

| # | Seam | File | What a lane adds |
|---|---|---|---|
| 1 | Extension registration | [`core/editor/config.ts`](../../config.ts) → `EDITOR_CHROME_EXTENSIONS` | one line, at the placeholder comment for its lane |
| 2 | Chrome mount host | [`features/editor/chrome/chrome-surfaces.tsx`](../../../../features/editor/chrome/chrome-surfaces.tsx) → `EDITOR_CHROME_SURFACES` | one entry, `{ id, render }` |
| 3 | Keymap contributions | `chrome.registerKeymap(...)` at a named scope | a runtime registration, no new extension priority |
| 4 | Stylesheet | [`features/editor/editor.css`](../../../../features/editor/editor.css) | one block appended under its own banner, below the `Chrome surfaces` rule |

Nobody edits `EditorView.tsx`. Nobody edits another lane's CSS block. A rebase
between lanes is then two hunks landing beside each other.

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
first. Order in `chrome.layers` is open order, so the last is topmost.

```ts
const handle = chrome.openLayer({ id: "link-menu", close: () => setOpen(false) });
handle.release(); // when the surface has closed itself
```

`close` and the surface's own dismissal must be the same path. The kernel calls
`close`; the surface's close path calls `release`. Closing here and popping the
layer here would race the exit animation.

`escStep` decides one step, in this order:

1. a drag or sweep in flight → cancel it (the owner's `onCancel` runs)
2. any layer open → close the topmost
3. the selection is on an object, or a caret is in a source block → caret past it
4. otherwise `at-home`, and the key is left unhandled

Law 3's three-step walk (source → object selected → caret after) is not three
cases: a diagram's source pane is a layer inside its dialog, so step 2 runs
twice and step 3 once. Verified end to end in the browser.

**Radix subordination (verdict: KEPT, 2026-07-29).** Radix owns its own
dismissal and the kernel owns the policy. Two mechanisms make that work:

- an open Radix surface registers a layer, so the chain knows it exists;
- `useChromeLayer` returns an `onEscapeKeyDown` every Radix content must
  carry. Radix dismisses from a document listener and cannot see a non-Radix
  layer opened inside one, so without it a single Esc closes the diagram
  dialog AND the source pane inside it — two steps of the walk on one key.
  The handler makes Radix defer while the kernel's topmost layer is not it.

The pre-decided floating-ui fallback was not needed: pointer positioning works
through a zero-size anchor (`pointer-anchor.ts`), Radix menus open
synchronously from inside `contextmenu`, and exclusivity holds under rapid
context switches.

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
- `insideTextSelection` — the pointer sits inside a non-empty text selection.
  Not "a selection exists": a selection three paragraphs away is not what the
  writer is pointing at, and shadowing the native menu there would spend
  spellcheck on nothing.

**Where the router listens.** ProseMirror's own DOM, plus any element carrying
`data-editor-chrome` (exported as `EDITOR_CHROME_ATTRIBUTE`). Chrome that
portals out of the editor — an object row, a table grip — must carry that
attribute or its right-clicks go straight to the browser. `OverlayIconRow`
already does.

**`grip` before `object`.** The design groups them ("object/grip"); they never
both match, because a grip is chrome and an object is a node. Grip is spelled
first as the more specific of the two.

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

```ts
const release = chrome.registerKeymap({
  id: "slash-menu",
  scope: "layer",
  bindings: { ArrowDown: (state, dispatch) => { /* … */ return true; } },
});
```

Register from a ProseMirror plugin's `view()` or a React effect, not TipTap's
`onCreate` — TipTap emits `create` a macrotask late, long enough for a first
keystroke to miss it. `ObjectPhysicsExtension` shows the plugin-view pattern.

Escape throws. Above every scope, outside this ladder, sits
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
- A surface-owned drag calls `chrome.beginDrag(onCancel)` and gets its end
  back. `onCancel` is how Esc reaches a drag the kernel did not start: without
  it the kernel could only stop suppressing, leaving a drop line chasing a
  pointer nobody is listening to.
- Approach chrome takes its timing from `chrome.createHoverIntent(...)`, never
  its own `setTimeout` — the kernel cancels these when a gesture starts.
  `CHROME_TIMING` holds the two numbers (`handleIntentMs` 100, `fadeMs` 120).

Hover intent is warm: once something is revealed the next thing under the
pointer answers without re-earning the delay, and leaving keeps the row for the
fade duration so the pointer can travel onto what it revealed.
