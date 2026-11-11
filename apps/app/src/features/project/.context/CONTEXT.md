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
`DesktopProject` lists the document hosts sorted by key, never by place: React moves a keyed child
that falls behind a sibling, and a moved host's DOM is re-inserted (scroll and caret reset) and,
in development, its effects are replayed (the app runs under TanStack Start's default
`StrictMode`), which destroys a live editor while its child effects still hold it (#1351). The
cost is that DOM (tab) order among documents follows their ids, not main-then-side.

Main holds tabs. `client/project-shell/main-tabs.ts` is the one record of what is open in main: an
ordered list of documents per project in this browser tab's sessionStorage, so a reload keeps them
and two windows keep their own. The address still names main's item. Arriving at an address
(`ProjectView`) opens or selects its tab, a new one to the right of the tab main showed last; the
address no longer resolving ends the arrival, so a document that comes back at it (restored from
another window) arrives afresh, and a document main shows always has its tab in the record. Later
descriptor changes only refresh a tab that is still open. Selecting a tab opens its document on its
view's draft or Live (`useOpenInMain`); closing main's tab replaces the entry with its right
neighbour, else its left, else Recently opened. Back and Forward reopen a tab the writer closed, by
design: the address leads, the tabs follow it. A close, a Discard, a removal or a vanished document
closes its tab through the coordinator's `tabs` port (`forget`; a draft-only page's own Close
closes it once main's address has left, so main's page is not drawn without it). `MainTabStrip`
draws the tabs in main's band with the inset sheet's folder-tab look. What main shows never depends
on the record: main's document with no tab in it, a chat, or an address that names nothing is the
active chip after the tabs, so a link to a deleted chapter keeps its URL and shows the removed page
in a tab of its own. New document (+) follows the document tabs only, never a chat or an
unavailable address, where it would read as a new one of those. The active chip never shrinks;
inactive tabs shrink to their icon, then the strip scrolls, with no scrollbar and a faded edge
where tabs are behind it (`useScrollEdges`, `scroll-fade-x`, as the editor toolbar). The keyboard
follows the tabs pattern: main's item is the one Tab stop, arrows, Home and End move along the
strip, Enter opens; each document's page has its own band, so the focus follows to the new one. Every control in the band shares the
chips' centre line. Stored tabs of documents deleted while the window was closed are not drawn
once the replica holds the catalog (`useLiveTabs`; the record is left alone, so a document that
comes back has its tab). Only documents take a tab: a tab is an item with a kind, and `TAB_KINDS`
is the switch for chats. A tab's Live or Draft view is its document's view, so it is per tab
already. The phone draws no strip; it records arrivals the same way.

Main shows what the address names, resolved by `resolveMainDocument` / `useMainDocument`
(`views.ts`), the resolver the phone uses too; `MainViewProvider` / `useMainItem` carry
`{item, document}`. The side shows one item, never main's. `resolveSide` (`side/side-item.ts`) picks
it: the held pick, else the chat this history entry was opened from (`meridianBeside` in history
state), else main's companion once its read answers, else a new-chat composer about main's
document. A document's companion is the newest chat that edited it (`/related`); a chat's is the
newest document it touched, else the last document. A document fits beside only once it is
described (`describe` in `context/open-project-document.ts`) and opens in the editor: one that
doesn't (removed, an upload) is skipped for the next candidate, and the picker offers only what
opens. `fitsBeside` is the one answer to "can this sit beside", for the rule and the picker. While
a read or a describe is out, the side keeps what it showed. The header names the item and says
no reason for it: the picker's rows say how each relates to main ("Edited this", "Wrote"). `side/SideView.tsx` holds this state and the commands
(`useShellCommands`); both shells read it, and the phone's sheet shows the same item. The sheet is no history
entry: Back while it is open dismisses it and leaves main where it is. The held pick
lives per browser tab (`client/project-shell/store.ts`, seeded from the device) and never enters
history, so Back moves main and leaves the hold alone. Only the writer's own acts release a hold:
the held mark, For this, the close button, the held item becoming main, and its document being
closed, Discarded or removed. A fold from a narrow window is not one: the hold survives it and is
back when the window widens. A held chat also gives way when the writer opens a chat in main (no
chat sits beside a chat), and a held document that no longer opens is dropped.
Every document link follows one click rule (`useLinkPlacement` in `review-launch.tsx`, the
gesture from `followDisposition` in `core/editor/links`): a plain click opens in main, and a
cmd-click, ctrl-click or middle click holds the page beside, with the link's Work, and opens a
closed side. Editor links, transcript links, chat doors and a reply's "Drafted N documents" rows
all go through it. The sidebar tree marks main's document only, never the side's. Each header renders inside its host
(`shell/MainHeader.tsx`, `side/SideHeader.tsx`); while the side is closed, main's header names it
(`side/ClosedSideButton.tsx`).

The side's new-chat composer (`useAttachAbout` in `features/chat/CreationComposer.tsx`) attaches
main's document only to an empty draft or over the chip it put there itself, which it remembers
with the draft (`AttachedAbout`), so a remount or reload still knows it. Its draft is its own
(`side-new-chat`, one per project in each browser tab), apart from the one `/chats` and main's new
chat use: a chip the side attached never reaches `/chats`, and words typed in `/chats` never show
beside a document. A Send that fails after the chat was made returns its words to main's new
chat, where the dissolved chat reopens. The composer reports what the draft is about (`NewChatAbout`), and the side's
name says that, not main's document.

Which documents are mounted is one list, `PresentedDocuments` (`context/presented-documents.ts`):
each document host registers its current descriptor there, and `shown` orders them newest on
screen first. Besides main's and the side's document, the newest open tab shown that is off screen
stays mounted as the kept host, hidden so its undo survives a return, so at most three documents
are mounted (main, side, kept). The kept document is mounted but not presented:
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
cached path on either shell: its review binds on arrival, and a plain URL there waits for the
address answer. Desktop and phone resolve the address the same way (`resolveMainDocument`): a document the
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

`routing/chat-navigation.tsx` is the single command seam for main: `openChat` always navigates
main to the chat, and `openNewChat` to `/chats`, main's new-chat composer. The side chooses its
own chat only through the held pick (the side's picker, or a chat created from the side's
composer). `display` is the chat main shows (`new` or one thread), null when main holds no chat;
`lastChatId` is the last chat opened (`readLastChat` in `client/project-shell/store.ts`). A chat
created from `/chats` takes main; one created from the side's composer is held beside. A link
followed inside a chat opens the page in main, and the entry records that chat as its beside
hint. A link or door to a page that chat drafted opens its draft (`useLinkPlacement`), with or
without a passage (a passage door opens the draft at its top: draft editors don't register as
passage targets yet); a cmd-click, ctrl-click or middle click holds the page beside main instead,
on that draft when the chat has one. No chat sits beside a chat, so a chat in main takes the side's picker down
to documents.

There is no chat index. The sidebar's Chats list (`shell/sidebar/ChatsBody.tsx`) is how chats are
found: a find field over the server's chat search, Favourites, the scoped Work's chats, and an
"All chats" disclosure that pages the whole feed 24 at a time with Show more. Each row renames in
place, toggles Favourites and deletes with an Undo line in the list.

A chat delete belongs to the project, not the list (`shell/sidebar/chat-deletes.ts`, mounted by
`ChatDeleteProvider` in `ProjectView`): its notice survives switching the sidebar's list, closing
the phone's drawer and remounting the sidebar, and ends on the next delete, Dismiss, leaving the
project, signing out or a reload. The delete takes main to `/chats` and lets go of a held side pick
at once; the chat's saved composer words and unsent records stay held (`beginOwnChatDelete` in
`client/chat-submissions/deleted-chat.ts`) until the notice ends without Undo, and then go only if
the server still says the chat is deleted: no answer keeps them for the next load's sweep, since
another tab or device may have restored it. Undo returns main to
the chat only if main is still on `/chats`, and the pick only if nothing has been picked since. A
chat with a reply running asks first: the server stops the run in the delete and Undo can't
restart it. Every restore goes through `ChatDeletes` (Undo, and `restore` for a trashed chat's
Restore line), so a restore of the chat a notice names ends the notice without dropping anything.
`restoreProjectChat` resets the chat's snapshot query rather than invalidating it: a cached
"deleted" error would read as proof the chat is gone when it next mounts. Nothing lists
trashed chats; after a reload a deleted chat is reachable only by its address.

The displayed-chat variant is derived from the URL. Primary-list lookups may supply Work and
header projections but never decide the body identity or reject a subagent.

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
the opened review's focus in the presenting container; a command adapter may request a launch but must
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
