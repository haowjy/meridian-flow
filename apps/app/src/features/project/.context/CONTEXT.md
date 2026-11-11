# features/project — desktop project shell

Route grammar and `?work` are in
[Project Addresses Are Screen-First](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/chat/entry-and-navigation.md);
identity order and admission are in
[Routes find their document by identity](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/documents/browser.md#routes-find-their-document-by-identity).

## Desktop shell

Desktop renders a single flat grid with stable direct-child slots:

```text
rail-l | left-resize | center | dock-resize | dock
```

`dock` is the side's slot id. Each host (`SlotGrid` `hosts`: `{key, slot, children}`) is keyed by
what it holds, a document (`document:<id>`) or the chat. Moving an item between main and the side
changes its `grid-area`, or parks it; it doesn't portal, reparent or remount a stateful surface.

Main shows what the address names, resolved by `resolveMainDocument` / `useMainDocument`
(`views.ts`), the resolver the phone uses too; `MainViewProvider` / `useMainItem` carry
`{item, document}`. The side shows one item, never main's (`resolveSideItem`): the last chat beside
a document; beside a chat, the newest document shown in main or the side, else the head of
Recently opened. Each header renders inside its host (`shell/MainHeader.tsx`,
`side/SideHeader.tsx`).

Which documents are mounted is one list, `PresentedDocuments` (`context/presented-documents.ts`):
each document host registers its current descriptor there, and `shown` orders them newest on
screen first. Besides main's and the side's document, the newest one shown that is off screen
stays mounted as the kept host, hidden so its undo survives a return; beside a document the side
is a chat, so at most two documents are mounted. The kept document is mounted but not presented:
it reviews nothing, admits nothing, writes neither pin nor address, raises no removed notice and
is not on screen for removals or availability. A close, a Discard and a removal `forget` the
document through the removal coordinator, so nothing picks it again and its host unmounts (taking
its draft-only presentation with it). Nothing here is persisted.

Slot wrappers paint their material, and document shells stay transparent. The Write | Chat switch is not a mode:
it stores `sidebarList` (`client/project-shell/store.ts`, per browser tab) and `SIDEBAR_LISTS` picks the
sidebar body, so flipping it never navigates. Widths are per slot; the sidebar and the side panel each have one open/closed
preference for every kind of main. Preferences hydrate before the desktop component
mounts, and `ProjectView` gates the mount rather than placing a conditional between hooks. One
merged layout subscription is the only whole-preferences subscription.

The two panel toggles are `ProjectShell`'s corner buttons, drawn once over the grid, so they
never move when a panel opens or closes. A header under one keeps a `PanelToggleSpacer` in its
place instead of a button of its own. A panel's content slides in on open; the grid columns
change in one step, because animating them reflows the chapter on every frame. Region separation is tonal. Repeated header primitives are
shared.

## Routes

The authenticated project route keeps `ProjectView` mounted across same-project child paths.
Typed route controllers own push/replace, and leaves parse no URLs. `repairAddress` is reserved
for canonical, entry-guarded replacement.

Rename or move prepares the open document's new locator and the replacement address as one
navigation commit, so the old address keeps its identity continuity until the new one is accepted.

A presented document is its id; its path, name and owner are a display cache the replica
refreshes. A route is bound to a document only when that is proven, and the bound selection records what proved
it (`by`). A navigation that names the document (a tree open, a Recent row, a chat door) binds the route it
opens in `commit()` (`enterRoute`), and any other URL (paste, reload, Back/Forward) stays a
candidate until its address answer binds it (`addressRouteBinding`), so the path's occupant
decides there. A document found by its cached path may paint but never binds. A selection about another
route than the URL begins again (`ProjectContextRemovalController`), so a binding that lands late
cannot stay stale.

A review address binds its route to the item's document at once (`reviewDocumentId` on the
controller, or a navigation that carries an item, `by: "review"`) and owns its path: the availability planner does not relocate that
binding, the follow hook does not follow it, and it is never a candidate for rejection. The
binding ends with the item: Back onto the same path without it begins a candidate, and
`ReadableProjectRoute` stops counting it in that render. A writer's exit from the review or its
close keeps the document (`adoptReviewBinding` makes it a navigation's), because the drafted path
still has to be repaired to the live one.

A bound document the address catalog does not list holds (`holdsBoundDocument`): the answer naming
another document is the path's occupant, so the route waits. The hold asks `resolveForOpen` once:
`available` goes to that location; anything else, a rejected lookup included, drops the binding
(`unbindRoute`, only while the selection is still bound to that document at this route) so the
address answer decides. The lookup takes a plain navigation ticket, never the writer's intent. A
failed catalog during a hold shows the error with Retry. A draft-only document is not found by its
cached path on the phone either (`useMobileRouteBinding`): its review binds on arrival, and a
plain URL there waits for the address answer. Desktop and phone resolve the address the same way (`resolveMainDocument`): a document the
destination area's catalog lacks (a draft that creates it, or moves it to another area) comes from
the address's answer (`addressedDocument`).

An empty (No Work) Editor selection lives in href-scoped history state, so Back/Forward and reload
keep it.

Route admission observes only its addressed draft's close lifecycle, never account-wide
Apply/Discard revisions: waking it for command progress rerenders the persistent project tree
before local feedback can paint.

Launching review on another document pushes history. On the current document, or adding or
removing `?item=`, it replaces the entry, so Back never toggles review.

An archived Work's chats stay live, and sending doesn't unarchive.

Work creation, archive, restore, delete, rename and Goal editing keep their own failure and undo
evidence on the destination or row. Command projection is the single optimistic read model, and
account switches clear queued commands. Archive focus follows the Work to its destination tab and,
on refusal, returns to the origin tab if the user hasn't moved focus elsewhere.

## Navigation and chat

`routing/chat-navigation.tsx` is the single command seam: `openChat` always navigates main to the chat; there is no side-only
chat selection. `display` is the chat main shows (the index or one thread), null when main holds
no chat; `currentThreadId` is the last chat opened, which the side shows beside a document. A link
followed inside a chat opens the page in main and the chat moves to the side. On the phone, chat
outside the Chat screen reveals the local Sheet.

The displayed-chat variant is derived from the URL; a chat may stay mounted behind the index
but isn't the displayed chat. Primary-list lookups may supply Work and header projections but never
decide the body identity or reject a subagent.

## Document review state

What a document paints is its document view (`client/project-shell/document-views.ts`), keyed by
document id per account and project in session storage: Live or Draft, the pinned draft (owner and
item), and Show changes. A document opens on Live; a draft paints only when the writer picks it or
arrives at an address naming it, and a draft-created document paints its own draft. `views.ts`
resolves the paint and holds it while the pinned owner's list loads, so a document never paints
Live and then the draft.

Every document host (main, the side, the phone) has its own review (`DocumentReview.tsx`);
`useReviewAdmission` makes it enter, keep or leave the draft its paint names. Only a host on screen
reviews: a host that is not showing (the kept document, a closed side) paints no draft, admits
nothing, holds no draft room and writes no pin. That keeps one review per document, and Discard
writes into the issuing host's own editor, whose Undo takes it back.

Main's address and main's view stay in step (`use-review-address-sync.ts`): an address arriving by
push, pop or load sets or drops the pin; after that the view writes the address by replace. The
side's view never writes the address. Launchers live in `review-launch.tsx`. Keep `PaintHold` and
`FocusOpenedReview` in the presenting container; a command adapter may request a launch but must
not manage focus or copy.

## Document admission

A bound document with no source is pending, never a cached occupant. Catalog errors and pending
refreshes don't prove absence.

The opening record is taken from main's host, not an intent or create path. It updates
locally before a server POST, and the POST waits for `whenOnServer`. The side and the kept host
record no open.

`ProjectAddressDocument` only canonicalizes the address and publishes its admission issue; it
installs nothing. Main's host paints the document the address names.

Background review launch, paint hold and focus handoff stay with the presenting container; the
document host never invents a second review controller.

## Entry and offline

Child navigation and same-href history-state writes never reload the persistent loaders, which
permits warm offline editing, not cold offline boot. Project creation writes an account-scoped
creation record before navigating: it stands in for loader data while pending or failed and never
grants authority.

The basic `EditorView` is a static dependency of the project hosts, so a loaded empty workspace can
start local writing offline. Library intent and the creation form may warm workspace code but don't
preload the project route loader, which would repeat owner and shell-data reads.

## Related context

- [`editor-document-lifecycle.md`](editor-document-lifecycle.md)
- [`resource-lifecycle-architecture.md`](resource-lifecycle-architecture.md)
- [`../mobile/.context/CONTEXT.md`](../mobile/.context/CONTEXT.md)
- [`../context/.context/CONTEXT.md`](../context/.context/CONTEXT.md)
- [`../chat-index/.context/CONTEXT.md`](../chat-index/.context/CONTEXT.md)
