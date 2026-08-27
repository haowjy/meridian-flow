# domains/projects — Default project bootstrap

Minimal Meridian-specific bootstrap code for the first authenticated workspace.
This domain is not the full project CRUD surface; that lives in
`../projects/` and is used by the upstream-parity `/api/projects/*` routes.

## What it owns

- **Default bootstrap** — `ProjectRepository.ensureDefaultBootstrap(userId)`
  idempotently creates or reuses the user's personal project, default `Writer`
  agent, first work, manuscript context source, `chapter-1.md` document, and
  primary thread.
- **Bootstrap URI** — `DEFAULT_BOOTSTRAP_URI` is `manuscript://chapter-1.md`.
- **Work domain** — `WorkRepository` owns Work metadata/lifecycle persistence;
  `resolveNewChatFallbackWork` owns the narrow omitted-root-create fallback policy,
  and `listWorkCatalog` owns the owner-gated catalog projection across Work
  persistence and collab pending-draft counts.

## Contracts

| Contract | Purpose |
|---|---|
| `ProjectRepository.ensureDefaultBootstrap(userId)` | Returns the converged `DefaultBootstrap` bundle for the authenticated user. |
| `ProjectRepository.ensureDefaultBootstrapReady(userId)` | Auth path: performs one idempotent repair check per process, then uses the durable completion flag as its lock-free fast path. Seed failures leave no partial bootstrap and return false without failing unrelated requests. |
| `DefaultBootstrap` | Project, work, thread, document, context source, agent definition, and URI IDs needed by the app shell. |
| `WorkRepository` | Creates/lists/updates/archives/unarchives/deletes/restores Works; delete is guarded by all Work-owned durable content. Its `transaction` boundary keeps compound Work commands atomic. |
| `listWorkCatalog(deps, input)` | Owner-gates and lists the requested Work collection, then enriches it through one set-oriented pending-draft count read. |
| `createWork(input)` | Creates a Work and durably enqueues affected thread Work context in the same transaction; it never changes the new-chat fallback. |
| `updateWorkTransition(workId, input)` | One metadata policy for the human PATCH adapter and LLM `work.update`: locks the lifecycle row, normalizes and compares requested semantic fields, persists only real changes, enqueues context delivery, and returns exact before/after/changed facts. `updateWork` projects its final Work for routes; LLM receipts remain outside this shared operation. |
| `deleteWorkTransition` / `restoreWork` | Both lifecycle transitions lock and return exact state, including concurrent no-ops, and durably enqueue Work context only after real changes in the same transaction. |
| `resolveNewChatFallbackWork(user, project)` | Reads the internal repair-only fallback for root creation whose `workId` was actually omitted. A null or dangling pointer falls back to newest active Work, newest archived Work, then concrete default creation; it repairs that pointer with CAS and retries if another repair won. Explicit JSON `workId: null` is invalid at the route boundary. |
| `requireWorkOwner(workId, userId)` | Owner gate for flat `/api/works/:workId` item routes. |

## Invariants

- The bootstrap transaction takes a Postgres advisory lock scoped to the user id
  so concurrent first-load requests converge.
- The personal project is selected by `projects.userId`, `isPersonal = true`,
  and `deletedAt IS NULL`.
- The default agent slug is `writer`; the default Work name is `Book 1`; the
  initial primary thread is titled `Chapter 1`, so its stable thread slug is
  `chapter-1`, and it links to the chapter document with `relationship = "editing"`.
- Re-running bootstrap must return the same logical bundle instead of creating a
  second personal project, manuscript source, chapter document, or editing
  thread.
- WorkOS `external_id` is the sole automatic user identity key. Email collisions
  across external IDs fail closed and never merge local accounts.
- Chapter seeding is initialize-only and is decided from canonical journal state,
  never from `markdown_projection`. Any admission or checkpoint means initialized.
- The project, chapter row, initialize-only canonical seed, live manifest
  membership, primary thread, and readiness flag commit in one ambient
  transaction. Interruption leaves no partial bootstrap.
- Auth provisioning performs one idempotent bootstrap repair check per user and
  repository instance so older ready projects with a ghost chapter gain manifest
  membership without replacing writer content. Later ready checks take no
  advisory lock and never enter collab.
- Readiness becomes true only after document authority and manifest membership
  are durable, rather than merely after row existence.
- The new-chat fallback is internal and sticky per `(userId, projectId)`: an archived
  fallback remains valid. Work management, creation, metadata, lifecycle, and explicit thread-rebind
  commands never write it. Only an actually omitted root-create `workId` reaches
  fallback resolution and repair; explicit null is invalid. Human Chat rebind and
  model `work.switch` remain explicit, separate commands.
- Work collections nest under `/api/projects/:projectId/works`; Work items and
  their thread lists are flat under `/api/works/:workId`. Collection responses
  contain only the requested catalog Works and never resolve, repair, or expose
  the new-chat fallback.
- Work slugs are stable project-unique handles assigned at creation. Rename does
  not change a slug; soft deletion releases both active name and slug uniqueness.
- Work deletion refuses live thread memberships, unreviewed drafts, and live
  files or folders in Work-owned context sources. Empty provisioned sources do
  not block deletion. Work-owned context mutations and deletion serialize on the
  Work lifecycle row lock; the draft predicate is evaluated inside the deleting
  transaction after that lock. Reviewable branch-journal creation and redo use
  the same lifecycle boundary. Restore refuses rather than clobbering a
  reclaimed active name or slug.

## Relationship to `domains/projects`

`domains/projects` carries the copied upstream repository and owner-gate
surface: project CRUD, work list/search/touch, user provisioning, and
`requireProjectOwner`. Only omitted root-chat creation resolves through
`resolveNewChatFallbackWork`; Work-list routes are pure catalog reads.
Route wrappers under `/api/projects/*` should stay thin over this domain.
