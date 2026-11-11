# Chrome primitives — contracts

The Esc chain and policy live in the kernel's
[`core/editor/chrome/.context/CONTEXT.md`](../../../../core/editor/chrome/.context/CONTEXT.md).

## Layers

Document hosts keep a hidden editor mounted (the kept document, a closed side), so the host receives `active`.

Menus and popovers are non-modal. A menu item that opens a form therefore closes without
stealing focus from the form, and the deeper form consumes the next Escape first.

A lane using a hand-rolled root has to supply the same `onCloseAutoFocus`,
`onEscapeKeyDown`, `layer.scope` and `keys` contract. `dismissal: "self"` is only for a
surface with its own Escape listener; otherwise the kernel backstop has to stay available.

Blocked rows use `aria-disabled`, stay hoverable and focusable for their reason, and
swallow selection. Radix's disabled prop isn't equivalent, because it removes that path.

## Anchoring

`OverlayIconRow` has two modes. `{ inside: element }` is a node view's attached CSS corner,
so reflow can't leave a stale rect. `{ over: element }` is a measured pane overlay for
ProseMirror-owned elements.

`overlayRect` provides pane-relative geometry; `overlayViewport` answers visibility of the
target, not placement. Pointer and Radix point anchors stay in viewport space.

`NodeHold` carries identity through transactions; a remembered element or position is not a
target.

A suggestion surface opened while the writer types uses `focusOnOpen="prose"`: its rows
can't take focus and cancel their own mousedown. A scroll-edge fade belongs to the element
that scrolls.

A lane owns only its anchor materialization, probe/row contents and command behavior.
