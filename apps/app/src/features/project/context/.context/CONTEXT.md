# features/project/context — contracts and architecture

Reference depth. Read the [AGENTS.md](../AGENTS.md) first.

## Link navigation versus editor admission

Resolved No Work survives routing in browser-entry state without an empty query parameter. Work-capable tabs without a
`workId` belong to No Work; viewer reads and route matching must not inherit the
host Chat Work. Nullable authority is ready for Context bootstrap and removal
host registration, not a loading/missing-Work state. No-Work server tabs use
route selection; the selected-tab map uses the empty-string key for shared project scope.

`ProjectDocumentNavigationAdapter` opens both tracked editors and existing
read-only Context viewers through the one stable-ID opener. Its lower-level
`not-editable` result means no live Yjs admission, not a failed navigation:
Editor-eligible project binary/custom metadata still opens a viewer tab and route.
Scratch/Uploads instead route to the deferred-viewing notice without opening a tab. The resolved file's
Work/no-Work authority overrides the invoking surface's Work; only project-scoped
files retain host Work context. Never add upload-specific navigation in Composer.

Availability command admission rejects while removal is suspended or disposed;
an empty successful receipt would let the availability owner falsely acknowledge
unapplied authority. Local settlement still differs from session-effect completion:
failed session effects remain pending for retry. This is not durable namespace
receipt recovery across account/authority shutdown.

## Account resource ownership

`AccountResourceReplica` is the sole browser owner for editable document
resources. It composes the account-qualified metadata database, serialized
catalog acquisition, namespace journal runner, exact local content access, and
same-session server adoption. `AccountFeatureLifetime` installs it before
project descendants and connects its two-phase close to the document-session
runtime. Account close fences new commands immediately, aborts transport work,
drains adoption/catalog/namespace operations, releases every retained session,
and closes metadata last.

The replica uses short account/resource Web Locks for namespace and terminal
coordination. Typing and ordinary local content access do not hold those locks.
A stable resource handle survives document-ID remint; the exact persistence name
and mounted Y.Doc do not change.

## Architecture

```text
ContextTreePanel (desktop)          MobileContextBrowser (mobile)
       │                                     │
       ├─ useContextCatalogView (projection) ┤
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
              ├─ ContextTabBar (reviewing tab surfaces dock tone)
              ├─ DraftReviewHeader (review strip, above the identity bar)
              ├─ DocumentIdentityBar (breadcrumb + chips, incl. DraftReviewChip)
              ├─ ContextEditorMountHost (warm tracked + local-resource Yjs editors)
              └─ ContextViewerHost (active binary viewer)
```

`AccountResourceReplica` serializes compact catalog snapshots and whole-commit
deltas into durable checkpoints. React Query triggers acquisition and delivers
results, while every tree, picker, restored local tab, and reference browser
projects from the same replica state. Applied revision advances only through
contiguous whole commits; observed head may lead while a bounded replay has more
pages. Local resource locations overlay server checkpoints by stable resource
identity and remain visible across offline reloads.

Editable-file create, rename, move, and delete commands write ordered durable
resource intentions before transport. Folder commands retain the direct context
mutation adapter. A failed file delete restores the row with a retry marker; a
failed placement reopens the identity field. Cache absence never supplies
removal evidence.

The project availability coordinator watches server-backed tabs, bound route
selection, retained sessions, and capped recent routes by stable file ID. Exact
delete receipts enter it directly; explicit authorization-loss observers and
focus, online, and bounded polling recheck watched identities. A catalog wake
for a cold Work triggers the same exact-ID availability path without warming a
second tree. Cache omission is presentation state and never removal evidence.
Generation-bearing final commands own the atomic tab, route, selection,
admission, working-set, and Yjs session effects; same-ID moves and local-new
tabs survive. Opening requires exact final availability plus a live opener and
admission.

`useFileSuggestions` projects directly from the normalized scope views. It
never walks or caches a second recursive tree and never adds a server-search path; hosts constrain
schemes and file/directory kinds, then mount the presentation-only list.

Desktop scheme/query orchestration lives in `ContextTreePanel`; `ContextTreeRows`
selects each expanded row's direct children by stable parent ID through one
scheme-scoped environment. Mobile renders one level at a time via route params.

## Editor tabs and local documents

The writer-facing destination is **Editor**. `ContextRemovalCoordinator` owns
workspace removal, route continuity, Work pruning, and generation-bearing
availability effects. `AccountResourceReplica` independently owns resource and
content durability. Neither owns the other's state.

New creates one initialized local resource and opens its exact Y.Doc before any
server request. The tab stores the resource handle immediately. Empty reserved
documents remain local and recoverable; first meaningful content or explicit
filing records the immutable create-eligibility witness and schedules the durable
namespace runner. A successful create transfers the same session into authorized
registry ownership. A create conflict remints the document ID while preserving
the resource handle, persistence database, Y.Doc, editor ancestry, tab instance,
cursor, and undo history.

`contextTabFromResource` is the single optimistic tab projection. An unnamed
local resource is `new`; an explicitly filed local resource immediately becomes
a route-owning `tracked` tab even while offline; acknowledgement keeps it tracked
and preserves whether its name is still provisional. Projection reconciliation
targets the resource handle, so a delayed old document ID cannot replace a
reopened member. Closing a tab removes only browser-local membership. It never
deletes the durable resource.

The device Context desk persists membership, order, tab-instance IDs, and one
selection per Editor scope in sessionStorage. Each browser tab/window has an
independent desk. Project bootstrap keeps durable local members from the replica
without remote availability admission; ordinary server members still use exact
availability. Accepted navigation commits browser history and workspace state in
one prepared operation. Returning to an empty Editor does not restore a closed
document.

## Document identity bar

`DocumentIdentityBar.tsx` is the one identity surface: a fixed-height mono
breadcrumb band (`Unfiled › Untitled 4`) at the top of the active tab's canvas,
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
- **Placement grammar** (any Unfiled document or provisional document): the jade chip opens
  an EMPTY field — the content-derived suggestion is ghost placeholder text
  (Tab/→ accepts it; Enter on an empty field accepts it implicitly). The
  popover opens on the scheme roots (Manuscript / Knowledge Base / User —
  the roots ARE the context choice); picking drills into folders, building the
  home as read-only spans left of the name. Enter with a home built moves
  (+renames); name-only Enter renames in place — naming isn't homing.
  Naming stays in Unfiled; filing changes source membership.
- **Graduated grammar**: the same chip and field handle homed documents. The
  field opens with the current name selected, while the dropdown offers the
  current folder's siblings and the Manuscript, Knowledge Base and User filing
  roots. Selecting a folder drills deeper and builds the destination prefix, so rename, move, and
  rename-plus-move remain one gesture without a second popup or name row.
- **Commit seam**: the field submits one final `{ destination, name }` to
  `use-identity-commit.ts`. The hook resolves the stable resource handle and
  writes one durable location intent. The optimistic resource projection updates
  the tab and route immediately; the namespace runner later settles the exact
  server receipt. A same-name explicit Save clears provisional presentation.
  Navigation additionally requires that the committed document is still active.
  The field does not blur-dismiss while a save is pending.
- **Repair receipts**: a failed placement remains `needs-repair` in the journal.
  The identity field reopens with the writer's name and recovery note; retry
  settles the failed attempt and appends a new immutable intention. Failures are
  never inferred from catalog absence.
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
  only when local content is usable without current server authority. While the
  field is open only the
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

Desktop right-click context and visible ellipsis overflow map one ordered action
specification through thin renderers for Radix `ContextMenu.Item` and
`DropdownMenu.Item`. They remain separate trigger primitives. The visible path
uses the neutral `OverflowMenu` and canonical trigger shared with Project chat
rows and Composer; context-specific `EntryAction` types do not cross that UI
boundary. The raw ContextMenu renderer consumes the canonical declarations from
`components/ui/dropdown-presentation.ts` directly for surface, row, separator,
destructive, density, focus, and animation paint. Do not copy those recipes or
introduce a shallow ContextMenu wrapper family merely to adapt Radix. The
visible target is 32 px for fine pointers and 44 px for coarse/no-hover input,
and it remains visible while its portaled menu is open. Mobile uses the same
context adapter with a 44 px target. Labels, icons, grouping, destructive
metadata, order, presentation, and dispatch actions therefore cannot drift.
The ellipsis stops propagation so it doesn't trigger the row's click handler.
`EntryAction` is four actions in fixed order — New file, New folder,
separator, Rename, Delete (creation first, destructive last) — identical in
both triggers. Actions dispatch from `onCloseAutoFocus`, after the menu has
fully closed with its focus return suppressed: menu teardown otherwise blurs
a freshly mounted inline row, and blur commits/cancels it.

## Creation targeting

One required `TreeCreationRequest` serves every entry point:
`{ scheme, kind, parentPath, workId }` (`TreeCreationProvider` request, or the phone
drawer's controlled mirror), with `""` meaning the scheme root. Scheme headers request the root; a folder
row requests itself; a file row requests its parent
(`parentContextEntryPath`). The single `TreeChildren` renderer inserts the
inline CreateRow at the target; the root calls it with an empty child list
before fetch, while nested folders use the same mount at child depth. Creation
explicitly reveals every target ancestor in the stored expansion model before
the request starts. Clicking any scheme or folder disclosure while the row is
open cancels creation and then performs the requested toggle; disclosure clicks
must never feel inert. Sibling-collision
validation uses the target folder's children. The captured `workId` keeps an in-flight request on its initiating Editor scope across route changes. Starting a creation anywhere
replaces a pending one; Escape/blur semantics are the shared
`useInlineNameForm` contract.

## Tree query invalidation

Deleting an editable file queues a resource deletion intent and hides the row
optimistically. A terminal receipt carries exact identity and generation into
session/removal authority. A transport or conflict failure restores the row with
a retry marker. Folder deletion still sends the direct context command and admits
its exact result to the availability coordinator. Tree absence never proves
document removal.

## Downlinks

- [Server context domain](../../../../../../../apps/server/server/domains/context/AGENTS.md)
- [Desktop project shell](../../.context/CONTEXT.md)
- [Mobile project shell](../../mobile/.context/CONTEXT.md)

File rename and the identity bar share the durable resource-location command.
Folder rename alone retains `context-identity-mutation.ts`. Inline operations
keep stable entry identity. Work selection is attached only to Scratch/Uploads,
never project-owned Manuscript/KB/User paths.

## Unfiled materialization and recovery

A new document is an account resource exposed to its creating project before it
has a server row. Reservation atomically records a stable handle, document ID,
exact persistence name, provisional Unfiled location, and a create intent whose
eligibility is initially null. Local persistence initialization completes before
the editor receives the handle.

First content marks eligibility once. Explicit filing both marks eligibility and
appends a location intent. The runner persists immutable request bytes before
HTTP, records outcomes before applying them, and resumes after response loss or
reload. Creation acknowledgement records canonical metadata and transfers the
same Y.Doc into registry transport. Closing every tab leaves the resource in the
sidebar; explicit Delete is the only writer command that removes it.

A foreign-ID create conflict remints under the resource lock, cancels the old
unsubmitted dependents, and appends a retry plus rebased intentions for the new
identity. Aliases let every browser context update its existing detached session
without replacing its Y.Doc. Unknown or uninitialized local databases are never
opened as blank documents.

## Editor versus chat resources

Editor tree and tabs admit project documents only. Scratch/Uploads remain valid
storage and reference/tool schemes; direct resource URLs show an explicit
viewing-not-available state. Persisted resource tab entries are removed without
deleting resource documents or durable local content. The deferred chat-launched pane
overlay is recorded in [TODO](TODO.md); it is not a tab or a whole-app modal.

Eligibility is enforced at every live workspace transition, including
bootstrap, adoption and availability updates. Hiding a resource row alone is
insufficient: a hidden tab must not remain eligible for close fallback.

Every editable tab keeps `ContextTabSessionBoundary` as the same React ancestor.
Resource-backed tabs resolve through their stable resource handle before and after
acknowledgement, placement, and remint, so metadata changes do not remount the
editor. Close releases the content lease; warm-view eviction does not close
registry transport retained for the open tab set.

## Browser-local Editor workspace

Zustand owns live membership. Restore snapshots use sessionStorage under
`meridian:editor-workspace:v1`, isolated per browser tab/window and never
projected from storage events. Layout persistence failure is reported without
rejecting New/select/Close. Old shared desk keys are not read or written. Resource
metadata and content persistence remain separate from browser-tab workspace membership.
