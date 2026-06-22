# domains/collab — server-side agent-edit composition

This domain composes the extracted `@meridian/agent-edit` core with Meridian
server persistence and Hocuspocus transport. The facade in `index.ts` is still
the compatibility seam consumed by context/upload/routes code, but it is now a
real adapter over the package core rather than a stub.

## What lives here

- **Facade types** (`index.ts`) — temporary `DocumentSyncPort`,
  `DocumentSyncFacade`, mirror/checkpoint method names kept until the next
  cutover passes update consumers.
- **Composition** (`composition.ts`) — builds the codec/model/core, translates
  facade origins to journal meta, implements full-document SET, checkpoint /
  restore, Hocuspocus hooks, and in-memory/prod factory wiring.
- **Agent-edit adapters** — `drizzle-journal.ts` (`UpdateJournal`),
  `hocuspocus-coordinator.ts` (`DocumentCoordinator`), `document-loader.ts`
  (journal → Yjs state), `drizzle-facade-store.ts` (server lifecycle,
  checkpoints, latest attribution), and `in-memory/agent-edit.ts` (test/app
  fakes).
- **Server-side helpers** — `domain/document-activity.ts` stays server-side;
  these are DB side effects, not agent-edit package concerns.
- **Old row-level stores** — `ports/document-store.ts`, `adapters/drizzle/`,
  and `adapters/in-memory/document-store.ts` remain for existing tests and the
  later facade deletion pass.

## Rules while this facade exists

- Do not change the facade shape just to reach the package core; consumers are
  intentionally unchanged during this cutover.
- Keep package imports one-way: server adapters import `@meridian/agent-edit`;
  the package must not import server code.
- Origin translation belongs in the facade composition layer. Collab `user` and
  `import` origins persist as package `human:<userId>` meta; missing-user
  imports would be `system`.
- Hocuspocus connection updates append directly to the journal and are tracked
  for drain/metrics; the coordinator is for exclusive live-doc access, not WS
  lifecycle persistence.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`packages/agent-edit/AGENTS.md`](../../../../../packages/agent-edit/AGENTS.md)
