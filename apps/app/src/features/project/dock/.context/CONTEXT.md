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
`commit`), then reveals the dock.
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

What a document paints is its document view (`client/project-shell/document-views.ts`), keyed by
document id per account and project in session storage: Live or Draft, the pinned draft (owner and
item), and Show changes. A document opens on Live; a draft paints only when the writer picks it
(the version menu) or arrives at an address naming it, and a draft-created document paints its own
draft. `../views.ts` resolves the paint and holds it while the pinned owner's list loads, and
while the list lacks the pinned item until a fresh read confirms it ended, so a document never
paints Live and then the draft; a failed read shows on the document, with the pin kept. Picking a
Work returns every view showing a draft of a live document to Live. Every document host (Editor
tab, dock, phone) has its own review (`../DocumentReview.tsx`), and `useReviewAdmission` makes it
enter, keep or leave the draft its paint names. Only a host on screen reviews: off Write the
Editor's frame stays mounted with the tab the dock holds, and warm tabs sit hidden, so a host that
is not showing paints no draft, admits nothing, holds no draft room and writes no pin. That keeps
one review per document, and Discard writes into the issuing host's own editor, whose Undo takes it
back. The focused change moves both ways: a
change the writer focuses is written to the pin, and a pin that moves by itself (reload, shared
link, Back) focuses the change it names, or the first when that change is gone. Main's address and
main's view stay in step (`../use-review-address-sync.ts`): an address arriving by push, pop or
load sets or drops the pin and, in Write, selects the tab it names once that tab exists; after that
the view writes the address by replace. A replace is not an arrival unless it changes main's
document: `@tanstack/history` mints a new entry key on every replace, so the sync tracks which
arrival each replaced entry belongs to. Anything else that ends a draft drops the pin itself
(`endPin`); dropping the item from the address does not. A link to an ended draft drops the item by
a replace that marks the entry's history state `reviewEnded`. A review stays open after its draft leaves its owner's list while
the view says Draft, so the last Apply keeps its editor, Undo and "No changes left" until the writer
chooses Live. A launch opens the document and pins the draft with its focused change once the navigation commits. Launchers live in `../review-launch.tsx`.

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
