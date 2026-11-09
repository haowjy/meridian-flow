# features/project/dock — dock document contracts

This reference covers the dock's document slot, tab-store opening, tab
persistence, paint continuity, and review ownership. Read [`AGENTS.md`](../AGENTS.md)
first; document session and editor behavior remain in the context/editor
features.

## Slot and placement

The dock holds Chat on Work/Editor and the context rail on Chat. A Work or Chat
surface may present one editable document through `ContextDocumentHost` and
`DocumentPaneChrome`; it owns no session, room, capture, or review controller.

Keep the primary body at one tree depth across center/dock placement. Cover a
parked body with an inert overlay rather than unmounting it. The slot paints
its material; document shells stay transparent. `DockDocumentIdentity` owns
one navigable path/header and receives `identity: null` in the body to avoid a
second filename. Rename/move belong to file lists.

The dock shows the project's selected tab (`useSelectedOpenDocument`); it has no document
store. A chat door opens or selects a tab through the tab store (`use-dock-placement.ts`
`commit`), peeking as the one preview tab unless the writer keeps it, then reveals the dock.
"Open in Editor" shows Write; "Close" closes the tab. Browser history and phone navigation do
not move documents between surfaces.

## Where documents open

Placement is decided once (`use-dock-placement.ts`). A chat door (link chip,
receipt, passage, `@` reference) or a Recent row opens *beside the chat* in the
dock only on the wide Chat screen, where the chat is in the middle, and the
address stays on the chat. A left-tree pick, a Scratch note included, goes to
the Editor on every screen. Work Files and the
dock document's path menus may also replace the dock document on Work. The
Editor screen (the chat is the dock) and the phone never hold a dock document:
those picks open an Editor tab or route, and a Scratch note opens full screen on
a phone. A removed or terminal document closes the slot; a rename updates its
header. A Chat-screen note stays open across chat switches and keeps browsing
its own owner's Scratch.

## Review state

A tab carries its own `view` (Live/Draft, Show changes), `preview` flag and optional `reviewPin`,
persisted in tab session v2 with draft-only tabs. The review controller follows the selected tab
(`ReviewAddressOwner`): it enters, keeps or leaves the review the tab names. The focused change
moves both ways: a change the writer focuses is written to the pin, and a pin that moves by itself
(reload, shared link, Back) focuses the change it names, or the first when that change is gone. A launch carries `ReviewFocus`: a group id with its
immutable projection frame. `FocusOpenedReview` waits for review paint and resolves only within
that same projection. A stale frame or a persisted bare id opens without that selection.
Launchers live in `../review-launch.tsx`.

## Review and paint

The dock has no Changes view. Review lists and command ownership stay in the
composer, identity row, phone sheet, and Work page. The host uses the shared
review binding and does not start a second projection or presence suspension.

Use `PaintHold` for continuity. Loading statuses, token handoff gaps, and an
unfinished review do not replace a retained snapshot; only completed paint
may. Launch and command adapters own no paint state or copy. A pane can settle
its route before the Editor mounts, but an unclaimed pending launch must not
restore a review a second time.

The mounted body is one editable document and its room; no dock-specific
session or capture path exists. Work changes, close, and project changes release
claims through the owning controller rather than by remounting from a local
component effect.

## Traps and links

- `tailwind-merge` cannot safely dedupe custom border-color classes; do not
  stack custom `border-border-subtle` classes on the slot.
- Keep `PaintHold`/`FocusOpenedReview` in the presenting container. A command
  adapter may request a launch but must not manage focus or the copy.
- [`../.context/CONTEXT.md`](../.context/CONTEXT.md) owns route and document
  admission; [`../../../editor/.context/CONTEXT.md`](../../../editor/.context/CONTEXT.md)
  owns editor review projection.
