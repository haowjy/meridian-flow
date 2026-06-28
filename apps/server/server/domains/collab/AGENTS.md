# domains/collab — server-side agent-edit composition

This domain composes the extracted `@meridian/agent-edit` core with Meridian
server persistence and Hocuspocus transport. `createCollabDomain` returns the
server `CollabDomain`: a thin application-facing surface over the package core,
the update journal, the live-document coordinator, and the **draft review
subsystem** (per-thread AI drafts routed to a Yjs-delta draft log instead of
the live document).

## What lives here

- **Domain types** (`index.ts`) — `CollabDomain`, update origins, checkpoint
  metadata, write results, Hocuspocus persistence metrics, `WriteMode`
  (`direct` | `draft`), `DraftClosedFinalizeResult`, and the `CollabDrafts`
  service surface.
- **Draft persistence + lifecycle** (`domain/drafts.ts`) — `DraftService`,
  `DraftStore`, `DraftProjectionCoordinator`, accept/reject with
  claim-token fencing, journal-first idempotent accept (`writeId=draft-accept:<id>`).
- **Draft-scoped agent-edit adapters** (`adapters/drizzle-draft-agent-edit.ts`) —
  per-draft journal/sync-state/lifecycle adapters that persist response writes
  under `scope_id` without touching live Yjs state.
- **Scope sentinel** (`adapters/drizzle-agent-edit-scope.ts`) — `LIVE_SCOPE = 'live'`
  vs draft-ULID `scope_id`, plus composable `scopedWhere`/`scopedValues` helpers.
- **Composition** (`composition.ts`) — builds the codec/model, translates
  Meridian origins to journal meta, wires the markdown-document engine, handles
  checkpoint / restore, Hocuspocus hooks, in-memory/prod factory wiring,
  the response-session registry (routes write-mode-aware cores), and
  the draft-service lifecycle (accept/reject with claim-token fencing).
- **Full-document markdown engine** (`domain/markdown-document.ts`) —
  server-side read/SET/edit orchestration over the package codec/model, journal,
  and coordinator. This is not part of the `@meridian/agent-edit` public mutation
  surface.
- **Agent-edit adapters** — `drizzle-journal.ts` (`UpdateJournal`,
  mutation metadata queries, server lifecycle, checkpoints, latest attribution),
  `hocuspocus-coordinator.ts` (`DocumentCoordinator`),
  `document-loader.ts` (journal → Yjs state), and `in-memory/agent-edit.ts`
  (test/app fakes).
- **Server-side helpers** — `domain/document-activity.ts` holds DB helpers for the
  post-write activity/projection hook; these are server read-model side effects,
  not agent-edit package concerns.

## Rules

- Keep package imports one-way: server adapters import `@meridian/agent-edit`;
  the package must not import server code.
- Origin translation belongs in the composition layer. Collab `user` and `import`
  origins persist as package `human:<userId>` meta; missing-user imports map to
  `system`.
- Hocuspocus connection updates append directly to the journal and are tracked
  for drain/metrics; the coordinator is for exclusive live-doc access, not WS
  lifecycle persistence. These connection-update appends do not fire the
  document-level activity/projection hook.
- `readAsMarkdown` reads the coordinator-owned live/persisted Y.Doc and serializes
  through the package codec/model. Context/storage projections are caches for
  listing and search, not a second live-document owner.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [Design: AI drafts & review](../../../../../../.meridian/git/haowjy-meridian-flow-docs/work/ai-version-branch-review/design.md)
→ [`packages/agent-edit/AGENTS.md`](../../../../../packages/agent-edit/AGENTS.md)
