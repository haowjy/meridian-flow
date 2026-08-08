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
  `resolveCurrentWork` owns per-writer selection policy.

## Contracts

| Contract | Purpose |
|---|---|
| `ProjectRepository.ensureDefaultBootstrap(userId)` | Returns the converged `DefaultBootstrap` bundle for the authenticated user. |
| `ProjectRepository.ensureDefaultBootstrapReady(userId)` | Auth path: performs one idempotent repair check per process, then uses the durable completion flag as its lock-free fast path. Seed failures leave no partial bootstrap and return false without failing unrelated requests. |
| `DefaultBootstrap` | Project, work, thread, document, context source, agent definition, and URI IDs needed by the app shell. |
| `WorkRepository` | Creates/lists/updates/archives/unarchives/deletes/restores Works; delete is guarded by all Work-owned durable content. Its `transaction` boundary keeps compound Work commands atomic. |
| `createWork(user, input)` | Creates a Work and selects it as that writer’s current Work in the same transaction, then refreshes project thread Work context once. |
| `updateWorkTransition(workId, input)` | Locks the Work lifecycle row, compares normalized requested semantic fields, and applies metadata and archive state in one write only when they differ. It returns exact before/after/changed facts used by receipts; `updateWork` projects its final Work for routes. |
| `deleteWorkTransition` / `restoreWork` | The delete transition locks and returns exact before/after/changed facts, including a concurrent delete no-op. Route wrappers refresh Work context only after real lifecycle changes. |
| `resolveCurrentWork(user, project)` | Reads the saved preference. Only a null or dangling selection falls back to newest active Work, newest archived Work, then concrete default creation; it persists that fallback with CAS and retries if another selection won. |
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
- Current Work is sticky per `(userId, projectId)`: an archived selection remains
  valid and the works list includes it even when the requested lifecycle filter
  would otherwise omit it.
- Work collections nest under `/api/projects/:projectId/works`; Work items and
  their thread lists are flat under `/api/works/:workId`.
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
`requireProjectOwner`. Multi-Work callers resolve selection through
`resolveCurrentWork`; repository ordering alone is not selection policy. Route
wrappers under `/api/projects/*` should stay thin over this domain.
