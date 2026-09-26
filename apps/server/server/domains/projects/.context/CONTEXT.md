# domains/projects — Projects and Work

This domain owns project persistence and bootstrap plus Work metadata and
lifecycle operations. `/api/projects/*` and `/api/works/*` routes are adapters
over its owner-gated operations.

## What it owns

- **Default bootstrap** — `ProjectRepository.ensureDefaultBootstrap(userId)`
  idempotently creates or reuses the user's personal project, manuscript context source, `chapter-1.md` document, the locked No Work row, and that Work's Scratch and Uploads sources. Bootstrap creates no thread.
- **Ordinary project creation** — creates the project-scoped Manuscript source before No Work and catalog initialization so the project has a manifest identity before it is returned. It does not seed a chapter document or Work-owned sources.
- **Bootstrap URI** — `DEFAULT_BOOTSTRAP_URI` is `manuscript://chapter-1.md`.
- **Work domain** — `WorkRepository` owns explicit Work metadata/lifecycle persistence, and `listWorkCatalog` owns the owner-gated catalog projection across Work persistence and collab pending-draft counts.

## Contracts

Project slug handles are owner-scoped, title-derived at creation, and stable
across renames. Browser `/p/{projectId}` and project CRUD routes instead use the
existing UUID, so title edits never rewrite a browser address. Both
personal bootstrap and ordinary creation serialize allocation on
the same owner lock. Project, Work and chat handles remain reserved through soft
deletion. Exact `findLiveByOwnerSlug` lookup is separate from UUID `findById`;
missing, foreign-owner and deleted handles resolve unavailable.

The repository `Project` uses `name` and `systemPrompt`; project HTTP routes
translate those to `title` and `description` in `ProjectDto`.

| Contract | Purpose |
|---|---|
| `ProjectRepository.ensureDefaultBootstrap(userId)` | Returns the converged `DefaultBootstrap` bundle for the authenticated user. |
| `ProjectRepository.ensureDefaultBootstrapReady(userId)` | Auth path: trusts the durable completion flag as its lock-free fast path. Incomplete bootstrap is retried transactionally; seed failures leave no partial bootstrap and return false without failing unrelated requests. |
| `ProjectBootstrapResult` | Project, manuscript document/source, and URI IDs needed by the app shell. |
| `WorkRepository` | Creates/lists/updates/archives/unarchives/deletes/restores Works; delete is guarded by all Work-owned durable content. Its `transaction` boundary keeps compound Work commands atomic. |
| `ProjectWorkAuthorityResolver` | Exact same-project `byId`/`bySlug` and transactional `lockById` resolution; it is the only projects-domain mint for opaque stable Work URI authority. |
| `listWorkCatalog(deps, input)` | Owner-gates and lists the requested Work collection, then enriches it through one set-oriented pending-draft count read. |
| `createWork(input)` | Creates an explicit Work and durably enqueues affected thread Work context in the same transaction. |
| `updateWorkTransition(workId, input)` | One metadata policy for the human PATCH adapter and LLM `work.update`: locks the lifecycle row, normalizes and compares requested semantic fields, persists only real changes, enqueues context delivery, and returns exact before/after/changed facts. `updateWork` projects its final Work for routes; LLM receipts remain outside this shared operation. |
| `deleteWorkTransition` / `restoreWork` | Both lifecycle transitions lock and return exact state, including concurrent no-ops, and durably enqueue Work context only after real changes in the same transaction. |
| `requireWorkOwner(workId, userId)` | Owner gate for flat `/api/works/:workId` item routes. |

## Invariants

- The bootstrap transaction takes a Postgres advisory lock scoped to the user id
  so concurrent first-load requests converge.
- Ordinary project creation persists its project-scoped Manuscript source, locked No Work, and catalog lifecycle state in the same transaction as the project row.
- The personal project is selected by `projects.userId`, `isPersonal = true`,
  and `deletedAt IS NULL`.
- Bootstrap creates no Agent, thread, or membership. It does insert the locked No Work
  row and that Work's Scratch/Uploads sources. System Agent provisioning happens at
  startup; root thread creation owns exact catalog selection.
- Re-running bootstrap must return the same logical bundle instead of creating a
  second personal project, manuscript source, or chapter document.
- WorkOS `external_id` is the sole automatic user identity key. Email collisions
  across external IDs fail closed and never merge local accounts. Provisioning
  serializes the exact email key before inspecting its owner; it does not define
  additional email canonicalization.
- Chapter seeding is initialize-only and is decided from canonical journal state,
  never from `markdown_projection`. Any admission or checkpoint means initialized.
- The project, locked No Work, chapter row, initialize-only canonical seed, live manifest
  membership, No Work Scratch/Uploads sources, and readiness flag commit in one ambient
  transaction. Interruption leaves no partial bootstrap.
- Auth provisioning treats the durable readiness flag as authoritative; legacy
  data repair belongs to a future import, not a process-local readiness overlay.
- Readiness becomes true only after document authority and manifest membership
  are durable, rather than merely after row existence.
- Omitted and explicit-null root-create `workId` both bind the project's locked
  No Work as primary. Human Chat rebind and model `work.switch` remain explicit,
  separate commands.
- Work collections nest under `/api/projects/:projectId/works`; Work items and
  their thread lists are flat under `/api/works/:workId`. Collection responses
  contain only the requested catalog Works and never select a Work implicitly.
- Work slugs are stable project-unique handles assigned at creation. Rename does
  not change a slug; UUID-shaped names keep their valid UUID-shaped slug. Soft
  deletion releases active name uniqueness but reserves the slug. Lookup direction is
  exact: ID resolution never falls back to slug resolution or vice versa.
- Work deletion refuses live thread memberships, unreviewed drafts, and live
  files or folders in Work-owned context sources. Empty provisioned sources do
  not block deletion. Work-owned context mutations and deletion serialize on the
  Work lifecycle row lock; the draft predicate is evaluated inside the deleting
  transaction after that lock. Reviewable branch-journal creation and redo use
  the same lifecycle boundary. Restore refuses rather than clobbering a
  reclaimed active name.
