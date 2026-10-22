# Chrome primitives — contracts

This reference covers the React half of editor chrome: mounting, layer
semantics, focus, anchoring, and shared stores. Read [`AGENTS.md`](../AGENTS.md)
first; the Esc chain and policy live in the kernel's
[`core/editor/chrome/.context/CONTEXT.md`](../../../../core/editor/chrome/.context/CONTEXT.md).

## Mounting and layers

`chrome-surfaces.tsx` is append-only, one registry entry per lane. The host
passes each surface its editor and no growing feature prop list. App scope is
the sole exception and is read with `useEditorScope()`.

The host receives `active`. Context hosts and the dock keep inactive editors
warm, but inactive chrome must not portal or paint over the visible document.
The host itself renders no layout element.

`EditorMenu`, `EditorPopover`, and `EditorDialog` register a layer with
`useChromeLayer`, scope nested content, defer Escape by depth, and return focus
to prose only when no successor layer has taken over. Menus and popovers are
non-modal. A menu item that opens a form therefore closes without stealing focus
from the form; the deeper form consumes the next Escape first.

A lane using a hand-rolled root must supply the same `onCloseAutoFocus`,
`onEscapeKeyDown`, `layer.scope`, and `keys` contract. Do not use an animation
frame or timer to race Radix teardown. `dismissal: "self"` is only for a
surface that owns its own Escape listener; otherwise the kernel backstop must
remain available.

Blocked rows use `aria-disabled`, remain hoverable/focusable for their reason,
and swallow selection. `ReasonTooltip` carries the on-demand explanation.
Radix's disabled prop is not equivalent because it removes that path.

## Anchoring and geometry

`OverlayIconRow` has two deliberate placement modes:

| mode | owner | placement |
| --- | --- | --- |
| `{ inside: element }` | node view | attached CSS corner |
| `{ over: element }` | ProseMirror element | measured pane overlay |

Node-view chrome is attached so reflow cannot leave a stale rect. ProseMirror-
own elements and all measured surfaces use the manuscript scroll pane,
`position: absolute`, and the pane's overflow clip. `overlayRect` provides
pane-relative geometry; `overlayViewport` answers visibility of the target,
not placement. Pointer and Radix point anchors remain in viewport space.

`useAnchorRect` follows `watchManuscriptLayout` for scroll, resize, editor
transactions, and anchor/root size changes. Results are coalesced and an
anchor that leaves the document returns null. `NodeHold` carries identity
through transactions; a remembered element or position is not a target.

`SuggestionMenu` owns the eight-row ceiling, list scrolling, edge fades, and
announcement. A suggestion surface opened while the writer types uses
`focusOnOpen="prose"`; its rows cannot take focus and cancel their own
mousedown. A scroll-edge fade belongs to the element that scrolls.

## Store and ownership seams

Use kernel external-store hooks for context, suppression, revision, hover, and
layout. Do not mirror these answers in local state or add a lane-local pointer,
scroll, or Escape authority. A lane owns only its anchor materialization,
probe/row contents, and command behavior.

`index.ts` exports primitives, not the host or registry. Import those directly
to avoid loading every surface and creating an initialization cycle.
