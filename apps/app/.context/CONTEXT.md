# @meridian/app — architecture and conventions

This reference records cross-module contracts for the frontend shell. Directory-local
guides carry feature rules; visual details live in [visual-conventions.md](visual-conventions.md).

## Browser records

`src/client/storage/browser-record.ts` owns best-effort JSON records with a
version/account/scope/payload envelope. Domain parsers treat malformed or
wrong-account records as absent; `undefined` means absent/invalid and
`null` may mean explicitly empty. Features own transitions and LRU. Old
formats are absent rather than migrated. Settings first-paint cache and raw
boot-script preferences are separate from this envelope.

## Server config, auth, and watcher boundaries

`src/server/config.ts` is server-only. It parses `APP_ENV`, `LOG_LEVEL`,
WorkOS settings, and `MERIDIAN_API_ORIGIN`; isomorphic helpers keep guarded
environment reads local instead of importing server config. Auth is WorkOS
AuthKit: hosted callback and dev login mint the sealed `wos-session` cookie,
and logout clears it. Dev autologin is production-disabled and requires its
explicit credentials.

The generated repository `logs/` tree is ignored by Vite's watcher, including
descendants but not similarly prefixed siblings. Do not weaken that boundary.

The dev API proxy (`apiHttpDevProxyPlugin`) skips WebSocket upgrades, which go
through Vite `server.proxy`. Its explicit route-owner inventory keeps
`/api/auth/callback` and `/api/auth/dev-login` in TanStack Start and forwards the
rest of the server-owned auth family, including `/api/auth/me`, to `apps/server`.

## State and transport seams

The visual layer reaches the substrate through public store/query/transport
ports, not adapter internals:

- `ThreadStoreState`/`ThreadStoreActions` own per-thread turns and actions;
  features import through `@/client/stores`. `ThreadCachePort` keeps list and
  snapshot projections in React Query while per-thread turns stay in the store.
- `useRenameThread` is the title command: project immediately, fence overlap
  and stale completion, revert a 4xx with row Retry, and retain an unknown
  outcome while invalidating for reconciliation.
- `useRebindThreadWork` is the one explicit composer-only Work rebind adapter.
  Work management and navigation never invoke it. Its cache convergence and
  durable transport owners remain separate.
- React Query owns project/thread/Work lists and HTTP snapshots. Passive readers
  share the host query options with `enabled: false`; never replace a live
  query function with `skipToken`. Any transition that affects Chat index
  invalidates its feed through the project/work projection seams. Favorite
  commands share one normalized project/thread authority across index and Work
  rows. The project store keeps the account clock and inserts confirmed creations
  into the project-list cache; it owns no second project list.
- `useWorks` exposes named catalog Works plus `noWork`. The new-chat composer's
  initial prospective choice is the first active (then first available) named
  Work, or No Work. The Work catalog never contains No Work, and Work management
  has no project-wide selection state and never resolves, repairs, or changes a
  chat binding.
- `ThreadTransport` (`@meridian/thread-client`) is the subscribe/cancel port;
  runtime uses the package's `ThreadSocketClient`, composed in
  `src/client/providers/TransportProvider.tsx`. The server event journal
  supplies replay across restarts.

Account-stamped chat submissions are acknowledged-submission witnesses, not
thread replicas or offline AI runtime. The first-send journal records the exact
structured authoring snapshot before navigation; acceptance retires it,
rejection stays on its row, and ambiguity retains it for replay. See the
[submission guide](../src/client/chat-submissions/AGENTS.md).

Trail evidence and peer marks are read-only; receipt Undo/Redo is the AI reversal
authority. `DocumentSession` owns collaboration state only, with no parallel
safety-notice presentation model. Collaboration self-suppression uses internal Meridian `UserId`, not
the WorkOS external identity.

## Live turns and transcript references

The turn reducer (`@meridian/thread-client`, `src/turns/`) is shared with `./mf`.
It maps sequenced AG-UI events into the `TurnStore` port; the thread store is its
adapter and owns one reducer instance. Optimistic reconciliation, cache
invalidation, thread-list patches, seq floors and the interrupt response UI stay
here. Live and settled assistant turns share the same `Turn` rows; partial blocks
are an in-flight status, not a second view model. `viewTranscript` (same package)
partitions blocks into ordered Process/Text/Artifact items, with Process
collapsed in place and Text/Artifact visible. Run state (`RunState`) is held per
chat in the thread store and read only through the package's selectors. See the
[chat guide](../src/features/chat/AGENTS.md) and
[composition reference](../src/features/chat/.context/turn-composition.md).

Transcript syntax and attachment authority are separate. `@meridian/markup`
parses wikilinks, but only an exact submitted `(documentId, uri)` grants
attachment occurrence navigation. Other follows go through the host link
follower and its resolution cache; a shown link registers with the surface's
single batched requester, and a relative chat link without a base is plain text,
not a link role or tab stop. Occurrence offsets refer to the original serialized
message, not decoded mdast; code/raw HTML remain inert. Keep authorized content
in one source block and map entity/backslash-decoded text with CommonMark's own
decoder; a regex scanner or second wikilink tokenizer will drift from the wire
grammar. Streamdown caches processors by plugin identity, so keep the occurrence
plugin a stable named option-taking plugin, key the renderer by occurrence
metadata, and pass live resolution through React context; dropping any one reuses
stale authority or resolution.

Removing a composer reference changes the draft, not Uploads. Upload deletion
is explicit; duplicate references and Undo/Redo must not revive a deleted file.
Same-identity Change retains intake provenance, while a new destination does not
inherit the former upload. The composer exposes intake but no file-deletion port;
removal is one history unit, and cleanup never lives in a reference menu,
transaction observer, or timer.

## Wire and snapshot contracts

`@meridian/contracts/protocol` owns AG-UI payloads and sequenced wrappers;
thread entities use string IDs and ISO timestamps. Both transports emit the same
shape and the reducer consumes it.

Snapshot application is data-sync/transport recovery work, never a view effect.
`applyThreadSnapshot` reconciles server history with local optimistic rows.
HTTP sync runs on route activation, new run, and gap; WebSocket recovery applies
snapshots on reconnect/gap. A mounted snapshot hook owns addressed block-upsert
projection and refetches missing targets instead of creating synthetic turns.

A local user turn starts as `turn_local_*`. The message response is the identity
bridge to the canonical server ID and supplies a server-computed
`snapshotFloorNextSeq`; acknowledgement raises the thread floor so stale
snapshots cannot remove the row. Snapshot `nextSeq` and WebSocket sequences
share wire space. Stale snapshots are rejected before cache/lifecycle effects;
durable-only addressed frames advance their own floor. Run resume cursors remain
independent.

First-send creation stays pending through admission, then activates the mounted
projection before attaching the run controller. Cached turns render first.
Activity, run-state, and Work/trail listeners join only after pending creation
clears; none subscribe or fetch a missing thread.
The first snapshot that shows work in progress re-subscribes from its cursor; there is no per-run resume.
Account replacement fences the old lifetime and stale Query responses.

## Client-led creation and navigation

Project creation mints its public UUID, journals creation inputs, and navigates to
`/p/<uuid>/works` before POST settles. The destination owns pending, failure,
same-identity Retry, and Discard; it never bounces to the library.

New-chat Send journals the message, mints local turns, selects the destination in
place, and lets the handoff persist create-or-get, admission, and run. Failure
stays on that chat. Retry reuses thread/message IDs; first-send ambiguity must
replay or reconcile in place rather than show lost-message recovery copy.

The authenticated root renders the project library, not a remembered project.
`/projects/new` is an overlay over that library. Every chat belongs to a
project; there is no project-less account composer. The account-home API and
last-active-project preference are gone; zero-project onboarding for a new
account is not decided here.

The project address is `/p/<project-id>`, where the UUID is stable across title
and slug edits. The first child segment is `chats`, `works`, or `editor`;
the bare project route canonicalizes to chats. Chat, Work, and project identities
are UUID-addressed. Work handles belong to context URIs, not browser URLs.
Editor documents/folders live under `/editor/…`; `?work=` supplies explicit
Work context, required for Scratch because the Work is the file's identity.
Uploads belong to a chat and have no Editor route. Recognized query keys are `work`, `settings`, `results`, and `view`;
omitted, explicit No Work, valid Work, and malformed values remain distinct, and
duplicate keys or malformed encodings are invalid rather than normalized.
Slug-shaped project routes and older shapes (`/project/<UUID>`, `screen`/`thread`/
`scheme`/`folder`/`path` queries) have no alias and render the unavailable state.
Inside the client, No Work is the locked row's id and Work-scoped tabs always
carry their Work id; only `workSelectionFor` spells it `none`, for
project-content addresses. The full grammar is in
[`features/project/.context/CONTEXT.md`](../src/features/project/.context/CONTEXT.md).

`ReadableProjectRoute` is the browser address parser and
`createProjectNavigation` owns history admission; keep route parsing and browser
history out of `routing/project-route.ts`. Chat UUIDs resolve by snapshot
identity, including subagents absent from the primary list. Main-destination
navigation pushes; dock chat selection updates browser-local current chat without
writing history; canonicalization and repair replace only while their captured
entry is still current. An unavailable explicit
target parks the requested host rather than falling through to a remembered
default. Desktop retains inactive child surfaces; phone may mount/unmount its
active leaf. Cross-project pending/error replaces the old project subtree, while
same-project failure parks the requested host. Chat index and Work each own one
screen-level `app-scroll`; neither adds a nested scroll owner. The Work screen
shows one list at a time under Active, Archived, and Deleted tabs.

## Authenticated shell and settings

`/_authenticated` mounts one unconditional composition:
Query → account lifetime → settings → project → thread → transport → copilot.
Never gate providers by pathname; conditional light and workspace branches once
dropped `ThreadStoreProvider` during transitions.
Account replacement synchronously fences the old lifetime before constructing the
new one; local rehydration does not gate initial render.

`AccountSettingsProvider` owns language, theme, Stats for nerds, and working-set
sync. Pending/failed setting commands own displayed intent; only confirmed
values are relayed, cached, or used to configure sync. Its account-stamped
first-paint cache contains confirmed snapshots only, and is used only when the
SSR server theme seed is unavailable (the seed wins). Text size is device-local.
`?locale=` is a local seed; explicit language commands take over. Settings is
the URL-addressable `?settings=<section>` overlay.

## Shared presentation rules

Every user-facing string flows through Lingui; locale resolution is centralized
in `src/lib/i18n.ts`. Use semantic tokens and the shared focus-ring,
visually-hidden, live-region, and keyboard conventions described in
[visual-conventions.md](visual-conventions.md). Announcements route through the
one shared live region fed by `useAnnouncement()`, and shortcuts belong in one
registry, not scattered `onKeyDown` handlers. The app's pointer cursor rule
is a human ruling (a dense app of quiet controls should not make the writer click
to learn what is clickable): one base-layer rule in `src/styles/globals.css`
covers buttons, links, and summaries minus disabled and `aria-disabled`, and
components add no cursor utility. Manuscript links remain text under the caret.
A shadcn refresh will try to take this back; it is a divergence we keep.

E2E fixtures may seed relational project/Work/thread/context shells through the
authenticated API or SQL, but never write Yjs content or
`documents.markdown_projection`; Yjs is authoritative and projection is a
derived cache. Teardown removes context sources and relies on cascades.

Related server contracts live in [the server context](../../server/server/domains/threads/.context/CONTEXT.md).
