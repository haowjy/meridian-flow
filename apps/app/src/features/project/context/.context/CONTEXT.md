# features/project/context — contracts and architecture

Reference depth. Read the [AGENTS.md](../AGENTS.md) first.

## Architecture

```text
ContextTreePanel (desktop)          MobileContextBrowser (mobile)
       │                                     │
       ├─ useContextTree (React Query) ──────┤
       ├─ useCreateEntryForm ────────────────┤
       ├─ useRenameEntryForm ────────────────┤
       ├─ useDeleteConfirmation ─────────────┤
       └─ ContextEntryActions (menus) ───────┘
                     │
              useInlineNameForm (shared core)
                     │
          validateContextEntryName (pure)

ContextPaneController
       ├─ route ↔ server-tab reconciliation
       ├─ in-memory ContextTab[] (tracked, viewer, and new)
       └─ ContextViewer
              ├─ ContextTabBar
              ├─ DocumentIdentityBar (active tab's breadcrumb + chip slot)
              ├─ ContextEditorMountHost (warm tracked + untitled Yjs editors)
              ├─ ContextViewerHost (active binary viewer)
              └─ EditorBannerSlot (draft chrome only)
```

`useContextTree` fetches `/api/projects/:projectId/context/:scheme/tree`.
Mutations (`create`, `rename`, `move`, `delete`, `upload`) invalidate the tree
cache on success. Invalidation is scheme-scoped. Foreground identity saves and
background untitled create/move reconciliation share
`context-identity-mutation.ts`; every successful receipt invalidates its
materialized tree or both move endpoints, even when no tab is open.

`useFileSuggestions` composes those same cached per-scheme queries and ranks a
flattened client-side view. It never adds a server-search path; hosts constrain
schemes and file/directory kinds, then mount the presentation-only list.

Desktop scheme/query orchestration lives in `ContextTreePanel`; `ContextTreeRows`
renders recursive rows through one scheme-scoped environment. Mobile renders one
level at a time via route params.

## Editor tabs and untitled documents

The writer-facing destination is **Editor**. `ContextPaneController` owns route
reconciliation, tab selection/close behavior, last-route restore, work-scoped
pruning, and scroll restoration. `ContextTab` has three variants: `tracked`,
`viewer`, and the in-memory `{ kind: "new", documentId }` placeholder. A new tab
uses an ordinary `DocumentSession` from its first render, created detached so
Y.Doc + IndexedDB exist without opening an unauthorized server room.

`untitled-reconciler.ts` is the browser-independent materialization engine;
`untitled-reconciler-browser.ts` binds localStorage, APIs, editor sessions, and
React hooks. The localStorage registry (`meridian:pending-untitled`) stores one
record per document: a monotonic revision, materialization phase, desired identity, failure receipt,
and the pending timestamp. Explicit writer actions and recovery receipts are
therefore crash-safe. Reconciliation re-reads the live revision after every
await; an attempt may clear identity work or drain a record only when that exact
revision is still current, so the last explicit writer identity wins. Events
only schedule the same deferred, idempotent sweep. The sweep creates through
`create-untitled`, attaches the existing Y.Doc, waits for confirmed provider
sync, then drains the entry. A closed tab is not special: the same entry drives
a headless attach/flush. A never-materialized empty is the only path that clears
IndexedDB. A foreign UUID conflict clones the Yjs state into a newly minted
detached session and replaces the new tab's identity in place before retrying.
Named/viewed documents never enter this engine. Naming an otherwise-empty new document is itself pending materialization work: the explicit identity keeps the tab reload-safe and is applied immediately after the row is created.

After create returns, the placeholder becomes a normal route-owned `tracked`
tab in place. `provisionalName` comes from the tree DTO and drives the identity
bar's provisional state; a cached tree refetch refreshes open-tab metadata so a
cross-device rename eventually dissolves the state without another invalidation
channel. Desk-restored `new` tabs retain their sessions in explicit detached
mode; no transport is created before the server row exists. Successful
materialization restarts any terminal pre-row session before attaching and
waiting for durable sync.
Before materialization, active `new` tabs are projected from the desk store,
not reconstructed from `scheme`/`path` search params. New-tab navigation still
uses the canonical Scratch empty route, but a fresh project with no prior scheme
can activate its local editor immediately.

## Document identity bar

`DocumentIdentityBar.tsx` is the one identity surface: a fixed-height mono
breadcrumb band (`Scratch › Untitled 4`) at the top of the active tab's canvas,
on every document — tracked, provisional, viewer. Crumb/field text is `text-sm`
to match the suggestion-popover rows; `identity-bar-geometry.ts` owns the box
constants (26px band, 22px child boxes) and the zero-layout-shift contract
between rest and edit states. Provisional docs are a *state* of the bar (italic
leaf + jade “Choose a home” chip), never separate chrome; the editor banner
slot below the toolbar belongs to draft chrome alone, and identity chrome must
never occupy it again (structural separation, 2026-07-17).

The breadcrumb itself is **inert** — the chip is the only edit entry point.
Each crumb stays its own `data-seg` element because the next slice attaches a
VS Code-style per-segment navigator dropdown there; don't flatten the path
into one string.

Contracts:

- **Keystroke path**: at rest the bar renders from tab metadata only. The
  content-suggestion observer (300ms debounce, `writerOwnsName` latch) mounts
  only while the edit field is open on a provisional doc.
- **Placement grammar** (untitled docs never explicitly renamed or homed:
  provisional AND still at the default Scratch root): the jade chip opens
  an EMPTY field — the content-derived suggestion is ghost placeholder text
  (Tab/→ accepts it; Enter on an empty field accepts it implicitly). The
  popover opens on the scheme roots (Manuscript / Knowledge Base / Scratch —
  the roots ARE the context choice); picking drills into folders, building the
  home as read-only spans left of the name. Enter with a home built moves
  (+renames); name-only Enter renames in place — naming isn't homing.
  Placement happens once: any explicit save graduates the document.
- **Graduated grammar**: the same chip and field handle homed documents. The
  field opens with the current name selected, while the dropdown offers the
  current folder's siblings and every writable scheme root. Selecting a folder
  drills deeper and builds the destination prefix, so rename, move, and
  rename-plus-move remain one gesture without a second popup or name row.
- **Commit seam**: the field submits one final `{ destination, name }` to
  `use-identity-commit.ts`. That seam derives queue, no-op, or commit; every
  tracked-document commit uses the move transport so canonical collision
  locators and graduation semantics have one owner. A same-name explicit Save on a provisional
  document is therefore always a graduation, regardless of which surface
  submitted it. Conflicts return the canonical locator for Open-existing.
  Every asynchronous commit carries an operation generation. Every successful
  receipt invalidates caches; the latest receipt updates tab metadata even when
  inactive, while stale out-of-order receipts cannot overwrite it. Navigation
  additionally requires that the committed document is still the active tab.
  The field does not blur-dismiss while a save is pending.
- **Queued receipts**: a `new` tab's desired identity applies when the document
  materializes; its outcome is reconciler *state*
  (`queuedIdentityFailure(documentId)`), never a promise — the edit session is
  over when the intent is queued. A failed receipt reopens the field with the
  writer's name restored and the conflict/error recovery note; the receipt
  clears when the writer edits or leaves the field. Failures must never drop
  silently.
- **Field buttons**: the open field renders ✓/× icon buttons after it —
  additive mirrors of Enter/Esc (pointerdown is prevented so the blur-revert
  contract can't fire before the click lands). Keyboard behavior unchanged.
- **Chip slot**: right edge. The action chip is permanent (D4) and its label
  graduates with the document: jade "Choose a home" while provisional (opens
  empty placement), quiet outline "Rename" once homed (opens the same field,
  pre-filled and selected — rename is the common case, folder browsing keeps
  move discoverable). Viewer docs get the field too; uploads viewers carry no
  chip (no dead buttons). The device-only status (warning tokens,
  `TriangleAlert`) appears *beside* the action — quiet on its left, never in
  its place: placement commits queue durably offline, so device-only is
  exactly when the writer may want to file the document. It claims its spot
  after unsynced words persist for a 2s sustained grace — the clock is the
  reconciler's per-document `pendingSince`, so remounting chrome (tab
  switches) cannot restart the window. While the field is open only the
  action chip yields (the field is the action); the status stays.
- **Destination keyboard path**: ArrowDown/ArrowUp enters the suggestion list
  through its typed focus handle. Rows retain arrow wrapping and Enter select;
  folder selection can drill to arbitrary existing depth.

The tab strip still follows the settled tonal treatment: it paints nothing,
active tabs continue the canvas upward, inactive neighbors alone receive short
dividers, and the whole chip is the tab target.

## InlineNameForm semantics

The shared state machine in `use-inline-name-form.ts`. Adapters supply options;
the core owns focus, validation, and commit behavior.

**Submit:** Enter commits (unless pending or error-blocked). Escape cancels.
Blur-with-content commits (unless Escape already cancelled). Empty input =
cancel. Blocking errors refocus the input.

**Focus:** Auto-focus on mount. `requestAnimationFrame` retry handles Radix menu
focus-scope teardown — the menu's closing animation holds focus for one frame,
swallowing a same-tick `focus()`.

**Adapter differences:**

| Concern | `useCreateEntryForm` | `useRenameEntryForm` |
|---|---|---|
| initialName | `""` | `entry.name` |
| isCancelName | — | same as current name |
| siblingNames | all siblings | siblings excluding current |
| afterFocus | — | extension-aware selection |

Both adapters are ~25 lines. The shared core is ~100 lines.

## Dual-trigger caveat

Desktop context menu and kebab map one ordered action specification through thin
renderers for Radix `ContextMenu.Item` and `DropdownMenu.Item`. Labels, icons,
grouping, destructive metadata, order, and dispatch actions therefore cannot drift.
The kebab stops propagation so it doesn't trigger the row's click handler.
`EntryAction` is four actions in fixed order — New file, New folder,
separator, Rename, Delete (creation first, destructive last) — identical in
both triggers. Actions dispatch from `onCloseAutoFocus`, after the menu has
fully closed with its focus return suppressed: menu teardown otherwise blurs
a freshly mounted inline row, and blur commits/cancels it.

## Creation targeting

One required `TreeCreationRequest` serves every entry point:
`{ scheme, kind, parentPath }` (`TreeCreationProvider` request, or the phone
drawer's controlled mirror), with `""` meaning the scheme root. Scheme headers request the root; a folder
row requests itself; a file row requests its parent
(`parentContextEntryPath`). The single `TreeChildren` renderer inserts the
inline CreateRow at the target; the root calls it with an empty child list
before fetch, while nested folders use the same mount at child depth. Creation
explicitly reveals every target ancestor in the stored expansion model before
the request starts. Those ancestor toggles are ignored until creation ends, so
revealed folders stay open afterward. Sibling-collision
validation uses the target folder's children. Starting a creation anywhere
replaces a pending one; Escape/blur semantics are the shared
`useInlineNameForm` contract.

## Tree query invalidation

Deleting a file in `manuscript://` only refetches that scheme's tree. The
last-opened route (`context-last-route`) is also cleared on delete to prevent a
dead tab reference.

## Downlinks

- [Server context domain](../../../../../../../apps/server/server/domains/context/AGENTS.md)
- [Desktop project shell](../../.context/CONTEXT.md)
- [Mobile project shell](../../mobile/.context/CONTEXT.md)
