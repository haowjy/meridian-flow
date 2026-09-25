# features/project — Desktop project shell

The authenticated project workspace: one persistent multi-panel desktop surface
that swaps primary *destinations* (Chat / Work / Editor) without tearing down
its stateful surfaces. This file is the colocated contract for the shell — read
it before touching layout, the rails/headers, or the prefs store.
Settings is an auxiliary routed surface, not a primary destination.

Design intent lives in [`DESIGN.md` § Project shell](../../../../../../DESIGN.md).
This page is the *implementation* contract.

Mobile now lives beside this desktop shell as a sibling implementation. The
shared `ProjectView` selects `mobile/MobileProject` only through the phone
capability predicate in `usePhoneShell()`; desktop `ProjectShell` remains the
persistent multi-panel grid. Phone-specific contracts live in
[`mobile/.context/CONTEXT.md`](../mobile/.context/CONTEXT.md).

## Layout: one flat grid, stable surfaces

`layout/SlotGrid.tsx` renders the whole project as a **single flat CSS grid**.
Every stateful surface is a permanent direct child of one grid container for the
entire session. A placement change only mutates the surface wrapper's
`grid-area` (or parks it offscreen via `PARKED_SURFACE_STYLE` when inactive).
**Surfaces are never portaled, reparented, or conditionally removed by a screen
change** — that is what preserves chat scroll/draft and live document sessions
across navigation.

Slot topology (`layout/desktop-layout.ts`), one grid row across every screen:

```
"rail-l  left-resize  center  dock-resize  dock"
```

- **`rail-l`** — the left sidebar (destinations + project file tree).
- **`center`** — the destination's main pane (Chat index/Work route pane, or the
  Chat/Editor center surface).
- **`dock`** — the shared right dock. The context-rail occupies it on Chat; Chat
  occupies it on Work/Editor. It reads as **one persistent
  sidebar** whose inner content swaps — a single shared width/collapse pref
  (`slotPrefs.dock`), not a per-surface one.

There is **no `files` grid track**. The file explorer is the persistent body of
the left sidebar; `ContextViewer` owns only the Editor tab strip and document.

`LeftSidebar` is one column with a truncating project-title control,
Chat/Work/Editor navigation, the persistent project tree, an explicit View
projects link to the library, and account controls. The title replaces the
whole Meridian wordmark and compass mark; it identifies this project rather
than acting as a library link. The navigation rows are shared with mobile
through `WorkspaceNavBody`; project identity and the recursive tree are
desktop shell grammar.

Work is the dedicated collection/detail management destination. The collection reads
active and archived Work and owns creation and lifecycle entry points; it never selects
  a project-wide Work or rebinds a chat. Its response contains only named catalog
  Works and never lists No Work as a card. Route-owned detail and inline metadata consume
the typed catalog, PATCH mutation, and associated-chat query seams.
Work detail owns one page-scoped metadata controller. It coordinates the active field,
authoritative returned Work, field-local failure, and an awaited Save/Discard/Keep
editing decision with the route-owned navigation guard; leaves only submit intents through it.
Hard unload uses the router's native before-unload integration rather than a second
draft owner.
Incoming authoritative Work revisions update the clean baseline without replacing the
active draft. One-shot focus intents bridge detail close/delete to the collection;
they are route continuity, not Work selection or persistent state.
Detail composes identity and lifecycle, Goal, Description, pending drafts, Scratch,
Uploads, and associated chats. Associated chats use bounded cursor pages and the
same virtualized, borderless project chat row as the Chat index without adding a nested
scroll owner. The external-scroll hook measures the list in that owner's
coordinates and owns stable keys plus focused/menu row pinning. Their membership
is historical while the displayed Work is the
chat's current primary Work. Resource sections fail independently. Archive and
unarchive preserve the detail route; delete replaces to collection and restores focus
to an adjacent row. Both shells share this route-owned module. At phone geometry, text
must wrap without horizontal overflow and product controls retain coarse-pointer touch
targets.

The chat index is the project root (`/p/<project>`). It reads a flat,
cursor-paginated primary-chat feed ordered by last activity. Favorites is a
server-side filter, applied before pagination, and so is title search. The
shared row also serves Work detail. The index leads with the centered
`CreationComposer` (`hero` variant, autofocused on fine pointers): on the Chat
screen the index is New chat. The dock's empty chat owns the pinned variant,
with the same prospective Work and Agent choices, in the `ChatSurface` frame a
live chat uses so the first Send never moves the composer. Only an explicit New
chat focuses the pinned composer (a one-shot focus-request id in
`chat-navigation`, consumed by whichever composer renders it), never a page
load.

The index door sits in each pane's 40px band after the sidebar toggle, on the
same x as the Editor's Recently opened chip (`chat-index/ChatIndexButton.tsx`).
Center wears the tab-chip grammar: on the index the door is the active chip and
the current chat waits beside it as an inactive chip that reopens it. The dock has no index: its always-present header
carries the chat switcher, which lists the chats and New chat. Phone reaches the
index through the `Chats` breadcrumb ancestor instead of a door.

`routing/chat-navigation.tsx` owns one current chat per browser, account, and
project (`client/current-chat.ts`, never synced): a thread identity (primary or
subagent) or none. It publishes one `ChatDisplay` variant, derived at render
from the URL (never the reverse): the index with the current chat's id (for its
reopen chip), a URL-addressed thread, or the dock's thread-or-none. Consumers
switch on the variant instead of ANDing a thread id with an index flag; there is
no separate "current thread id" prop. The Chat screen's center is the index or
a chat path; the dock shows the current chat, or an empty New chat when there
is none. A chat path becomes the current chat, persisted only in an effect so
the URL always wins the same render. Chat nav reopens the current chat, or the
index when there is none. Commands keep the writer's screen: on the Chat screen
they navigate through the route's coordinator; elsewhere they point the dock at
the chat and call the shell's registered dock reveal (`useConversationRevealRouting`
lives inside `useProjectChatNavigation`, so every shell shares one reveal path).
Dock selection does not write the URL. Behind the index the chat surface keeps
the current chat mounted and hidden — its persistent thread id always tracks
the display's underlying chat, warm or not. **What is displayed, though, goes
to nothing on the index**: the context rail (`ContextSidebar`) and the draft
review scope both key off the *displayed* chat, which is null while the index
is showing, even though the surface stays warm behind it. Only the index's
reopen chip (`ChatIndexController`'s `CurrentChatChip`) reads the remembered
current chat directly. A confirmed snapshot 404 clears the current chat; a chat
path is replaced (never pushed) with the index so Back cannot land on it again.
Reload recovery (`recoveringFirstSend`) is decided once at mount; the phone
opens its chat sheet for it over Work or Editor.

First Send writes the durable account-stamped intent before selecting the new
thread. From the index it pushes `/p/<project>/chat/<id>`, so Back returns to
the index; dock selection remembers the chat and leaves the destination
untouched. Reload recovery
uses current chat identity, not a URL-only selector. The submitted Work, Agent,
and project are immutable reconciliation facts; no admission or visibility
handoff may run until the canonical thread matches them.

The QueryClient owns normalized Favorite intent per project/thread, fenced
against stale page arrival. A Favorite projects onto every cached row of that
chat at once; the Favorites filter hides an unfavorited row locally, but no feed
guesses membership. Favorite completion refetches only Favorites feeds. Work
membership is unchanged. No feed owns read/unread state. Lifecycle projection updates
`actionRequired` in cached rows when a subscribed thread emits; unsubscribed
threads are only refreshed by ordinary query reads, not a background signal.

Draft review follows the same persistent-shell rule with two sibling owners.
The hydrated project owns one Chat review value (Chat Work plus thread) and one
Editor review value (Editor Work, no thread authority) above desktop/phone
selection. Boundaries only re-provide those values: ChatSurface and the Chat
context dock share the Chat value, while viewer/editor surfaces receive the
Editor value. An explicit latest-wins route handoff carries review commands into
the matching Editor, advertises them only after route success, and claims them
only after Work, manuscript path, mounted document, and draft membership agree;
it survives phone view unmounts because the owner does not.

A chat has one current Work binding. The new-chat Work choice is prospective creation
state only; it never invokes the rebind command. The Chat composer may explicitly
rebind an idle existing chat through the canonical durable transition, and the
model's explicit `work.switch` command uses that same separate authority. Work
management and navigation never rebind a chat implicitly.

The desktop rail contains Manuscript, Knowledge Base, User and Unfiled. Chat
resources have no Editor sections or resource tabs. Editor Work remains a route
context for draft review, independent of later Chat changes. Null is shared
scope; loading/error is never converted to null. Invalid optional query selectors
are cleared without blocking documents; required path identities remain errors.
Archived Work identity remains manageable but cannot authorize content mutation.

### Slot paints the material; surfaces must not

Slot chrome is owned **entirely by the slot's `className`**
(`DESKTOP_PROJECT_SLOTS`). Region separation is purely **tonal** — no seam
borders, no shadows (slice-7 locked shape):

| Slot     | Material |
|----------|----------|
| `rail-l` | `shelf-surface` — the flat grey-gold shelf (chrome one shade darker) + scoped role remaps (globals.css) |
| `dock`   | `dock-surface` — the chrome material (≡ the tab band) + airlight atmosphere |
| `center` | `bg-background` |

A surface that hardcodes its **own** background overrides the slot it sits in and
produces the classic white-band / green-flash bugs (e.g. an old `bg-background`
on `ChatSurface` painting a brighter band under the dock header). **Let the slot
paint.** `SlotGrid` never branches on slot kind — chrome is pure data.

**Three large-surface tones (slice-7):** the shell's primary regions use three materials —
the shelf (`--color-shelf`, the chrome's grey-gold one shade darker; the
app's standard black ink, with only
contrast-failing roles remapped via `shelf-surface`'s scoped shelf-* tokens),
ONE continuous L-shaped chrome field (`--color-sidebar`: the
center cell — `chrome-field`, whose top-left rounds against the shelf on the
shared `--radius-md` — plus the entire dock, identical where they meet; the
dock alone adds the `dock-airlight` floor gradient, transparent in the band's
reach), and the lit page (`--color-background`, the brightest surface, rising
as each pane's `page-sheet`: top-right rounded on `--radius-md`, square and
flush on the rail side). **Bands never paint**: `PaneHeader`, `ContextTabBar`,
`DockHeader`, and the project-title header are transparent h-10 rows on their
cell's material. The project-title header inherits the shelf slot's surface in
both themes; the outer grid's `bg-muted` is a backdrop for the main-pane notch,
not the project-title header.
Only `--color-background`, `--color-sidebar`, and `--color-sidebar-accent` may meet
at the main pane/dock band seam — arbitrary surface tokens there re-expose the
notch wedge on palette change.
Chat|Changes in the dock is a CONTAINED
segmented track (a recessed ink-mix well whose active segment surfaces paper
inside the track's own boundary), deliberately not tab chips: only the page
rises out of a band. Two chips wear the tab grammar — the document tabs and
the centered chat header's title chip — both surfacing `--color-background`.

## One sidebar grammar (the reconciliation)

The shell once had four bespoke "sidebar + header + collapse + resize" surfaces
that had each drifted (different header heights, borders, toggle positions, label
weights, raw colors). They are now reconciled to **one reference: the left
sidebar (`shell/LeftSidebar.tsx`).** New surfaces follow it. The load-bearing
conventions:

- **Header row = `h-10` (40px), `px-2`.** Every
  header reads at the same height: project identity, dock/rail header, files
  header, editor header. Bordered rows use `border-b border-border-subtle`,
  not `border-border`. The project-title row has no bottom rule.
  **The two chrome strips** — the context tab strip
  (`ContextTabBar`, the band) and the dock header (`DockHeader`, transparent
  on the dock's own chrome) are the same `h-10` with tonal separation and
  **no bottom border** (see the shell tones above, and the tab-chip
  grammar in `globals.css`). Do not reintroduce a rule under either strip.
- **One collapse/expand control: `shell/PanelToggleButton.tsx` (`size-8`),
  inset `px-2`.** This is the canonical toggle column. **Invariant — "click
  without moving the mouse":** a surface's collapse button and the matching
  expand control that appears after it collapses MUST sit at the same screen-x.
  That only holds if every surface uses the *same* `px-2` inset; mixing insets
  breaks it. (This `px-2` deliberately supersedes the earlier `px-1` alignment
  from commit `30fa8a0`; `px-2` matches the LeftSidebar/PaneHeader reference.)
- **Status color via tokens** — `text-status-streaming`, `text-destructive` —
  never raw `emerald-*` / `rose-*`.

The repeating chrome is extracted only where it actually repeats
(`PaneHeader`, `RailPaneHeader`, `PanelToggleButton`) — not as
a god "RailShell" wrapper, because the chat dock is a `motion.div`, not a
`ResizablePanel`, and cannot be wrapped in a panel-baking shell.

## Surfaces & preferences

Stable surface ids (`layout/types.ts`): `threads`, `chat`, `context-viewer`,
`context-rail`.

`layout/surface-prefs-store.ts` is the **device-local** chrome-prefs store
(Zustand `persist`, localStorage key `meridian:project-surface-layout`,
`version: 3`). It stores width + collapsed per surface, plus the
shared `slotPrefs.dock`. **Slot placement is NOT stored** — it is a pure function
of the active screen, merged into a render-time `SurfaceLayoutMap` by the
placement module. `DEFAULT_*`/`*_WIDTH_BOUNDS` are the clamps.

Browser-storage keys use `meridian:` + kebab-case. Scope per-project/per-work/per-file
state inside the persisted value, not by appending entity ids to the key.

## Reload stability — the hydration gate (load-bearing)

The shell previously hit an intermittent **"Maximum update depth exceeded"** loop
on reload. Root cause: non-atomic prefs hydration racing with a redundant
whole-prefs subscription and a double-firing tab effect. The fix is structural
and must not be regressed:

1. The prefs store persists with **`skipHydration: true`**.
2. `routes/_authenticated.tsx` calls `useProjectSurfacePrefsStore.persist
   .rehydrate()` (synchronous — localStorage) then `setHydrated()` immediately.
3. **`ProjectView` gates the whole `DesktopProject` mount on `_hydrated`** so it
   mounts exactly once against final persisted prefs (at most one frame, no
   visible flash).

Two rules keep this stable:

- **Gate at the parent (`ProjectView`), never inside `DesktopProject`.** A
  conditional `return null` placed *between* hook calls is a Rules-of-Hooks
  violation ("Rendered more hooks than during the previous render"). Hoist the
  gate above the component that runs the hooks.
- **`DesktopProject` takes a single merged layout subscription**
  (`useProjectLayout`). Do not add a second whole-prefs subscription — that
  redundant subscription was part of the original cascade.

Related: the project removal coordinator publishes a revisioned auto-open block.
`ContextPaneController` consumes that external-store snapshot, so a removal blocks
same-render and delayed cached-tree resurrection. A registered route host stays
live while the writer visits another project screen; only host release or Work
readiness suspension disables activation. A parked desktop Editor retains its
private document and review state but is inactive: `ContextPaneController` must
not admit its retained document or repair the address until its host is active
again. Writer close and Work pruning are reversible, while acknowledged deletion
and draft discard keep exact re-entry guards against stale resurrection.

## Project routing, identity, and controllers

`routes/_authenticated/p/$projectId` is the persistent project parent and its
catch-all child is the only workspace route adapter. It loads the full project
by UUID, keeps `ProjectView` mounted for same-project child paths, and passes
resolved address state and typed navigation commands to controlled controllers.
Controllers never parse or mutate browser URLs themselves. Project title edits
do not change the UUID address. Desktop rail and phone drawer edit their own
project title inline: click/tap to focus and select, Enter or blur saves,
Escape cancels. The shared title editor keeps the draft and local error visible
through rejection, while `ProjectView` owns one optimistic title mutation and
cache rollback. It fences overlapping list reads before confirming a successful
rename so a late stale response cannot overwrite the title. The phone top bar
shows project identity without becoming a second edit surface.
`routing/project-address.ts` owns the
project UUID/browser grammar; `routing/project-navigation.ts` owns guarded
push/replace behavior. The legacy slug project routes and `?screen`/`?thread`
grammar are gone. `project-route.ts` retains stable-ID command types and the
context-removal CAS snapshot only; it is not a second address grammar.

Empty Editor Work selections are stored in href-scoped browser history state.
Only Editor-related destinations carry this marker; other screens must not
write state their address parser discards. Actual Work selections remain
readable query parameters. Current chat selection belongs to the working set.
A fresh copied URL without these parameters may use local defaults; Back/Forward
and reload preserve the entry's explicit no-selection intent.
Resolving those defaults does not itself replace the route. The departure
snapshot path freezes displayed choices before the destination push. Native
history is flushed before matching workspace settlement, so immediate reload
uses the accepted URL and browser-local layout. Document
admission still canonicalizes document paths and scope independently.

A project address has explicit selections, not defaults: absent, no-Work,
slug, malformed, and unavailable remain distinct. Only genuinely absent Editor selections may use local continuity.
The navigation coordinator matches rendered entries by history key, because
router and native URLs can spell the same query differently. Async tickets
still retain and validate the native URL, entry key, and navigation revision.
The shared query guard clears malformed or confirmed-missing optional Work
selectors using synchronous, entry-guarded history replacement, pinning no selection
without empty URL parameters. This same-destination repair bypasses blockers;
it never queues a competing navigation behind a pending dirty-edit decision.
Pending catalog refreshes and catalog errors never prove absence. Valid and omitted selectors are not rewritten. Duplicate query keys,
invalid percent encoding, and conflicting path/query Work scope remain parser
errors, not recoverable selector values. Required path identities never fall
back. Work and document path misses stay unavailable. Path and remembered chat IDs are identity, not primary-list lookups. A confirmed
snapshot miss falls back to the index.
Editor can seed its initially absent Work
from the selected Chat once; afterwards Editor Work is independent from Chat Work.
With no selected Chat it is explicit no-Work. The Work catalog never selects a
first Work for Editor.

A cold different-project transition replaces the old shell with an inert
boundary. Same-Work pending Editor navigation retains the usable document and
its identity chrome; recovery and unavailable/error destinations mask it.
The route publishes authorized tab metadata, while the document host owns
live-session binding. See [Editor document lifecycle](editor-document-lifecycle.md)
for entry paths, publication ordering, retention, and failure behavior.
Writer Close commits through accepted navigation; forced availability repair
remains an identity and revision guarded CAS over the current address projection.

The **Editor** destination retains `ContextPaneController` as its implementation
name. It owns address-admitted opens, temporary-tab projection, scroll
restoration. Screen entry resolves a still-open identity before navigation;
bare Editor routes remain empty. The empty Editor surface offers the
project's recently opened documents as a chooser, scoped to the project it
renders inside because that pane is one project's surface;
selecting one navigates, and the list never seeds a tab. Project-entry
workspace validation checks only
persisted browser-local members and never seeds them from server recents. It is
hydration-scoped and never re-runs on a Work change. The removal coordinator
owns close fallback, atomic old/new Work continuity, remembered destination,
and guarded route repair. A cold address can project loading until the
authoritative address resolver publishes its durable tab. Session binding and
content startup belong to the document host. An explicitly unavailable address
stays unavailable rather than selecting a fallback. Context paths are reusable
locations, never document identity.

The Chat navigation item reopens the current chat. New chat and chat selection
stay in the center on Chat, and in the dock on Work or Editor.

Chat switching lives in `features/chat/ThreadSwitcherPopover`; it filters by
chat title, groups chats by Work when meaningful, and delegates actual
navigation to the route owner. The route resolves current chat by exact identity,
including subagents. `ProjectView` uses a primary-list lookup only for the Work
projection passed to context hydration, Draft Review, and headers; that lookup
never chooses or rejects the chat body identity. Descendants must not re-derive
these projections. Subagents absent from the primary list do not receive that
Work projection.

## Don't

- Don't hardcode a surface background — let the slot paint the material.
- Don't introduce a second toggle inset value — `px-2` is the column.
- Don't reparent/unmount stateful surfaces on screen change — move the grid-area.
- Don't gate a mount between hook calls — gate at the parent.
- Don't add raw hex/rgba or `emerald`/`rose` — use semantic tokens.

Persistent root/account/project loaders acquire shell identity on entry. Child
navigation and same-href history-state writes do not reload them; explicit router
invalidation and re-entry still do. This permits warm local editing offline,
not cold offline app boot or bypassing server authorization.

The basic `EditorView` is a static dependency of the project hosts, not a lazy
chunk fetched on first New/open. This makes a loaded empty workspace capable of
starting local writing offline; it deliberately costs earlier editor-code loading
for Chat-only project visits. It does not provide cold offline application boot.

## Document system map

[Current project document architecture](resource-lifecycle-architecture.md) connects browser-local views, local creation, session persistence, catalog acquisition and backend synchronization. It separates resource durability, browser-local views, backend namespace acknowledgement, and Yjs synchronization.
