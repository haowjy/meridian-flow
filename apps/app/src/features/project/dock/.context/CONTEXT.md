# features/project/dock — dock document contracts

This reference covers the dock's document slot, claim-based opening, layout
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

A dock open claims the existing revision. The latest accepted claim wins;
Close, project/Work fences, and later opens supersede earlier attempts. Peeks
are not URL destinations, create no tabs, and return to the native occupant.
Only `DesktopProjectController` hands a visible document from the rail to the
Editor working set, installing the Editor tab before consuming the panel.
Browser history and phone navigation do not hand off.

## Where documents open

Placement is decided once (`use-dock-placement.ts`). A chat door (link chip,
receipt, passage, `@` reference), a Recent row, a left-tree click or a Scratch
note opens *beside the chat* in the dock only on the wide Chat screen, where the
chat is in the middle, and the address stays on the chat. Work Files and the
dock document's path menus may also replace the dock document on Work. The
Editor screen (the chat is the dock) and the phone never hold a dock document:
those picks open an Editor tab or route, and a Scratch note opens full screen on
a phone. A removed or terminal document closes the slot; a rename updates its
header. A Chat-screen note stays open across chat switches and keeps browsing
its own owner's Scratch.

The Editor's warm tab and the dock can bind one session at once; closing either
leaves the other bound, and the dock passes its visibility as the host's
`active`, so the two views are never both active.

The dock's review launch adapter keeps the chip, Next draft and auto-advance
inside the dock while the draft dock and Work list still launch into the
Editor. Both are writer-unconfirmed defaults; flipping one changes only that
adapter.

## Local layout

The account-stamped dock document layout is browser-tab session state. Restored
candidates remain hidden until hydration and identity validation; restore never
claims a revision or overrides an explicit writer pick. Invalid or terminal
identities cannot flash on screen. Project/Work changes fence old claims.

The document review address belongs to the occupant and is included in its
layout identity. The presented review is shared through `useActiveReviewBinding`;
draft-only settlement and address writes do not bump the document open revision.
A launch may carry `focusOperationIds`. The review claimant runs
`FocusOpenedReview` only after that review paints and its preview is loaded;
ids absent from the preview open at the top.

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
