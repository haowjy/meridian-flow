# features/project — Desktop project shell

The authenticated project project: one persistent multi-panel desktop surface
that swaps primary *destinations* (Home / Work / Chat / Editor) without tearing down
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
- **`center`** — the destination's main pane (Home/Work route pane, or the
  Chat/Editor center surface).
- **`dock`** — the shared right dock. Chat occupies it on Home/Work/Editor; the
  context-rail occupies it on the Chat screen. It reads as **one persistent
  sidebar** whose inner content swaps — a single shared width/collapse pref
  (`slotPrefs.dock`), not a per-surface one.

There is **no `files` grid track**. The file explorer is the persistent body of
the left sidebar; `ContextViewer` owns only the Editor tab strip and document.

`LeftSidebar` is one column with a linked wordmark, Home/Work/Chat/Editor navigation,
the persistent project tree, and account controls. The navigation rows are
shared with mobile through `WorkspaceNavBody`; the wordmark and recursive tree
are desktop shell grammar.

Work is the dedicated collection/detail management destination. The collection reads
active and archived Work and owns creation and lifecycle entry points; it never selects
a project-wide Work or rebinds a chat. Its response contains only catalog Works and
never resolves or invents a Work for no-Work chats. Route-owned detail and inline metadata consume
the typed catalog, PATCH mutation, and associated-chat query seams.
Work detail owns one page-scoped metadata controller. It coordinates the active field,
authoritative returned Work, field-local failure, and an awaited Save/Discard/Keep
editing decision with the TanStack route blocker; leaves only submit intents through it.
Hard unload uses the router's native before-unload integration rather than a second
draft owner.
Incoming authoritative Work revisions update the clean baseline without replacing the
active draft. One-shot focus intents bridge detail close/delete to the collection;
they are route continuity, not Work selection or persistent state.
Detail composes identity and lifecycle, Goal, Description, pending drafts, Scratch,
Uploads, and associated chats. Associated chats use bounded cursor pages and the
same virtualized, borderless project chat row as Home without adding a nested
scroll owner. The external-scroll hook measures the list in that owner's
coordinates and owns stable keys plus focused/menu row pinning. Their membership
is historical while the displayed Work is the
chat's current primary Work. Resource sections fail independently. Archive and
unarchive preserve the detail route; delete replaces to collection and restores focus
to an adjacent row. Both shells share this route-owned module. At phone geometry, text
must wrap without horizontal overflow and product controls retain coarse-pointer touch
targets.

Home is the shared, container-responsive Composer-led entry surface on desktop
and phone, followed by the server-owned Continue, Favorites, and
cursor-paginated Recent feed. First send creates and reconciles the canonical
thread under one stable client-chosen ID before routing. Home and Chats share
the saved prospective Work/Agent choices. Without a saved Work choice, creation
starts with the first active Work or No Work; archived Works are not defaults.
Loading, error, and authoritative empty catalogs remain distinct. The submitted
Work ID is an immutable reconciliation fact, along with project and Agent, and
no cache, handoff, visibility, admission, or route effect may run until the
canonical thread matches those captured facts.

The QueryClient owns one normalized Favorite record per project/thread so
navigation and stale page arrival cannot discard pending writer intent. Work
feeds remain immutable membership/order pages; only Home moves the affected
thread between its categories. Project chat lists have no read/unread or
open-acknowledgement state, and opening a chat performs no state mutation.
Thread lifecycle projection owns the independent `actionRequired` fact and
converges live and snapshot changes across Project, Home, and every matching
Work feed cache without writing Favorite.

Draft review follows the same persistent-shell rule with two sibling owners.
The hydrated project owns one Chat review value (Chat Work plus thread) and one
Editor review value (Editor Work, no thread authority) above desktop/phone
selection. Boundaries only re-provide those values: ChatSurface and the Chat
context dock share the Chat value, while viewer/editor surfaces receive the
Editor value. An explicit latest-wins route handoff carries review commands into
the matching Editor, advertises them only after route success, and claims them
only after Work, manuscript path, mounted document, and draft membership agree;
it survives phone view unmounts because the owner does not.

A chat has one current Work binding. Home's Work choice is prospective creation
state only; it never invokes the rebind command. The Chat composer may explicitly
rebind an idle existing chat through the canonical durable transition, and the
model's explicit `work.switch` command uses that same separate authority. Work
management and navigation never rebind a chat implicitly.

The desktop left rail has one divider below destination navigation. Its
Manuscript, Knowledge Base, User, Scratch, and Uploads panes are flush siblings
with transparent headers. Scratch and Uploads resolve from the shell-owned Editor Work, whose real name appears in their header tooltip and accessible control name. An explicit route Work is authoritative even while persistent Chat belongs to another Work; malformed, loading, catalog-error, and confirmed-missing explicit values never fall back to Chat or mount Work-scoped leaves. With no explicit Work, the selected thread's durable Work ID remains authoritative even when catalog display data fails. The Work catalog never implicitly selects the first Work for Editor. A new readable entry may seed an absent Editor Work from the selected Chat once; subsequent Editor selection is independent. With no selected Chat it settles to explicit no Work. Loading and errors never become an empty selector, and archived Work remains manageable but cannot authorize content mutation. Uploads is intake-only and exposes no file or folder creation affordances.

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

**Three-tone invariant (slice-7):** the shell is exactly three materials —
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
and `DockHeader` are all transparent h-10 rows on their cell's material. Only
`--color-background`, `--color-sidebar`, and `--color-sidebar-accent` may meet
at the band seam — arbitrary surface tokens there re-expose the notch wedge on
palette change. Chat|Changes in the dock is a CONTAINED
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

- **Header row = `h-10` (40px), `border-b border-border-subtle`, `px-2`.** Every
  header reads at the same height: left wordmark, dock/rail header, files
  header, editor header. Use `border-border-subtle`, not `border-border`.
  **Exception — the two chrome strips**: the context tab strip
  (`ContextTabBar`, the band) and the dock header (`DockHeader`, transparent
  on the dock's own chrome) are the same `h-10` with tonal separation and
  **no bottom border** (see the three-tone invariant above, and the tab-chip
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

## Readable routing, selection, and controllers

`routes/_authenticated/p/$projectSlug` is the persistent project parent and its
catch-all child is the only workspace route adapter. It resolves the slug before
ID-keyed queries, keeps `ProjectView` mounted for same-project child paths, and
passes resolved address state and typed navigation commands to controlled
controllers. Controllers never parse or mutate browser URLs themselves.
`routing/project-address.ts` owns the readable browser grammar;
`routing/project-navigation.ts` owns guarded push/replace behavior. The legacy
UUID project routes and `?screen`/`?thread` grammar are gone. `project-route.ts`
retains stable-ID command types and the context-removal CAS snapshot only; it is
not a second address grammar.

Empty Chat/Work selections are stored in href-scoped browser history state, not
serialized as `?chat=&work=`. Only Editor-related destinations carry the empty
Editor Work marker; other screens must not write state their address parser
discards, or normalization can race a blocked departure back to its source.
Actual selections remain readable query parameters.
A fresh copied URL without these parameters may use local defaults; Back/Forward
and reload preserve the entry's explicit no-selection intent.

A readable address has explicit selections, not defaults: absent, no-Work,
slug, malformed, and unavailable remain distinct. Only genuinely absent Chat
or Editor selections may use their respective local continuity rules. An
explicit unavailable selector parks the relevant host and never invokes catalog
fallback or Work normalization. Editor can seed its initially absent Work from
the selected Chat once; afterwards Editor Work is independent from Chat Work.
With no selected Chat it is explicit no-Work. The Work catalog never selects a
first Work for Editor.

A cold different-project transition replaces the old shell with an inert
boundary. Same-Work pending Editor navigation retains the usable document and
its identity chrome; recovery and unavailable/error destinations mask it.
The route publishes authorized tab metadata, while the document host owns
live-session binding. See [Editor document lifecycle](editor-document-lifecycle.md)
for entry paths, publication ordering, retention, and failure behavior.
The removal coordinator's route repair remains an identity and revision guarded
CAS over the current address projection.

The **Editor** destination retains `ContextPaneController` as its implementation
name. It owns address-admitted opens, temporary-tab projection, scroll
restoration, and screen-entry defaults. Project-entry desk seed/validation is
hydration-scoped and never re-runs on a Work change. The removal coordinator
owns close fallback, atomic old/new Work continuity, remembered destination,
and guarded route repair. A cold address can project loading until the
authoritative address resolver publishes its durable tab. Session binding and
content startup belong to the document host. An explicitly unavailable address
stays unavailable rather than selecting a fallback. Context paths are reusable
locations, never document identity.

The Chat navigation item opens the composer-and-history landing, including from
a chat detail. An already-open landing is a no-op. The switcher’s New chat
shortcut targets that same landing; there is no separate `/chats/new` route.

Chat switching lives in `features/chat/ThreadSwitcherPopover`; it filters by
chat title, groups chats by Work when meaningful, and delegates actual
navigation to the route owner. `ProjectView` resolves a chat once and passes its
current Work to context hydration, Draft Review, the chat body, and headers.
Descendants must not independently derive either value.

## Don't

- Don't hardcode a surface background — let the slot paint the material.
- Don't introduce a second toggle inset value — `px-2` is the column.
- Don't reparent/unmount stateful surfaces on screen change — move the grid-area.
- Don't gate a mount between hook calls — gate at the parent.
- Don't add raw hex/rgba or `emerald`/`rose` — use semantic tokens.
