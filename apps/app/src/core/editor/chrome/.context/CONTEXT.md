# Chrome kernel contracts

This page gives the detailed contracts behind the editor chrome kernel. The
kernel answers ownership and reach; surfaces own their content and local state.

## Context and layers

The right-click claimant is resolved synchronously from deepest applicable
object, cell, link, block, and caret context. Shift+right-click exits before
the ladder. A claimant may defer mounting its menu but never the browser event
claim. The fallback caret claimant keeps editor menus available in prose, cells,
and fences.

Measured chrome is anchored in the manuscript's content space, not the viewport.
Crossing into the viewport is an explicit one-way transition; chrome is never a
fixed-position overlay that tracks the content.

Each open layer has an ID, parent, depth, and focus scope. A top-level open
replaces its prior top-level sibling. A child opened from a menu must name its
parent; mount order is not depth because child effects may run first. The
deepest layer answers layer-scoped keys, then the chain falls outward by scope;
it never hands a key inward to a layer being covered.

## Escape and backstop

`escStep` is the single policy for gestures, layers, caret retreat, and
`at-home`. ProseMirror invokes it through `handleKeyDown`; Radix invokes it via
`onEscapeKeyDown`; the document backstop handles portals, moved focus, and
pointer-owned gestures. The backstop omits caret steps because focus is outside
the prose. A surface declaring self-dismissal must actually register its layer
or it will survive Escape.

Suggestion retreat is keyed by a stable owner ID. The lease contributes
backtrack and root dismiss; the chain offers them only when that suggestion's
layer is topmost. A pending owner is honored before React registration so a
first Escape cannot outrun the menu. No surface adds a keydown listener.

## Keymap reach and collisions

Contributions declare scope (`object`, `block`, `surface`, or `layer`) and may
narrow with `appliesTo`. A layer contribution may reach the document only when
its layer is the active owner. Same scope, same key, and overlapping predicates
are a collision and registration rejects them. Different scopes and explicit
predicates are the intended fall-through chain. Undo is mounted above the
kernel; do not raise the kernel to compete with it.

The document backstop uses the same contribution table and fences terminal or
destroyed owners. It must not read `event.defaultPrevented` to decide whether
Escape was handled: ProseMirror prevents key 27 while dispatching, regardless
of whether the chain found a step. Read the resulting kernel state instead.

## Approach and suppression

Approach chrome is not a Radix layer. The kernel retains the last pointer and
re-hit-tests through `watchManuscriptLayout` after scroll or layout changes.
One block owns hover chrome; lanes compose facts for that block. Selection and
table persistence are lane-owned and must not be cleared merely because no
pointer is present. Drag or sweep suppression is shared; private timers and
pointer listeners create competing answers.

## Escape walk and right-click menus

`escStep` decides one step in order: cancel a drag or sweep in flight; close the
topmost layer; move the caret past a selected object or source block; select the
object when the caret is in prose inside one (a caret in a table cell selects the
table, and the next Escape leaves it); otherwise `at-home`, left unhandled. A
diagram source pane is a layer inside its dialog, so its walk home is two layer
steps and one caret step. Closing a layer marks it out of the walk before calling
`close`, so a dismissal that never lands costs one Escape rather than all of them.
Radix content must carry `useChromeLayer`'s `onEscapeKeyDown`, or one Escape
closes a dialog and the non-Radix layer inside it.

Every right-click opens an editor menu and the context picks which. The ladder is
`link`, `text-selection`, `grip`, `object`, `cell-selection`, `caret`: a link
menu, the formatting menu over a swept prose selection or bare caret (plus Row and
Column verbs in a cell), a control's own menu, an object's menu, merge/split/align
over swept cells, and a fence's own verbs. The formatting claim moves the caret to
the pointer synchronously, because Turn into reads the selection. The router is a
capture-phase document listener because React node views swallow `contextmenu`
before ProseMirror handlers run; chrome portalled out of the editor must spread
`editorChromeAttributes(chrome)` or its right-clicks reach the browser. A table
cannot hold a `NodeSelection`; a whole-table `CellSelection` is how a selected
table is spelled, and `table` key scope goes quiet while `object` scope takes over.
