# Chrome kernel contracts

## Context and layers

Measured chrome is anchored in the manuscript's content space, not the viewport.
Crossing into the viewport is an explicit one-way transition; chrome isn't a
fixed-position overlay that tracks the content.

The deepest layer answers layer-scoped keys, then the chain falls outward by
scope. It doesn't hand a key inward to a layer being covered.

## Escape and backstop

ProseMirror invokes `escStep` through `handleKeyDown`, Radix via
`onEscapeKeyDown`, and the document backstop handles portals, moved focus and
pointer-owned gestures. The backstop omits caret steps because focus is outside
the prose. A surface declaring self-dismissal has to register its layer or it
survives Escape. Radix content has to carry `useChromeLayer`'s `onEscapeKeyDown`,
or one Escape closes a dialog and the non-Radix layer inside it.

Closing a layer marks it out of the walk before calling `close`, so a dismissal
that never lands costs one Escape rather than all of them.

Suggestion retreat is keyed by a stable owner ID. A pending owner is honored
before React registration so a first Escape can't outrun the menu.

The backstop can't read `event.defaultPrevented` to decide whether Escape was
handled: ProseMirror prevents key 27 while dispatching, whether or not the chain
found a step. Read the resulting kernel state instead.

## Keymap reach and collisions

A layer contribution reaches the document only while its layer is the active
owner. Same scope, same key and overlapping predicates are a collision that
registration rejects; different scopes and explicit predicates are the intended
fall-through chain. Undo is mounted above the kernel, so don't raise the kernel to
compete with it.

## Approach and suppression

Selection and table persistence are lane-owned and aren't cleared because no
pointer is present. Drag and sweep suppression are shared.

## Right-click menus

The formatting claim moves the caret to the pointer synchronously, because Turn
into reads the selection. The router is a capture-phase document listener because
React node views swallow `contextmenu` before ProseMirror handlers run. Chrome
portalled out of the editor has to spread `editorChromeAttributes(chrome)` or its
right-clicks reach the browser.

A table can't hold a `NodeSelection`; a whole-table `CellSelection` is how a
selected table is spelled, and `table` key scope goes quiet while `object` scope
takes over.
