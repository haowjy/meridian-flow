# domains/projects — Default project bootstrap

Minimal Meridian-specific bootstrap code for the first authenticated workspace.
This domain is not the full workbench CRUD surface; that lives in
`../workbenches/` and is used by the upstream-parity `/api/workbenches/*` routes.

## What it owns

- **Default bootstrap** — `ProjectRepository.ensureDefaultBootstrap(userId)`
  idempotently creates or reuses the user's personal project, default `Writer`
  agent, first work, manuscript context source, `chapter-1.md` document, and
  primary thread.
- **Bootstrap URI** — `DEFAULT_BOOTSTRAP_URI` is `work://manuscript/chapter-1.md`.
- **Compatibility stub** — `WorkRepository` is still a phase marker here; full
  work CRUD is owned by `domains/workbenches`.

## Contracts

| Contract | Purpose |
|---|---|
| `ProjectRepository.ensureDefaultBootstrap(userId)` | Returns the converged `DefaultBootstrap` bundle for the authenticated user. |
| `DefaultBootstrap` | Project, work, thread, document, context source, agent definition, and URI IDs needed by the app shell. |
| `WorkRepository` | Phase marker only; do not add work CRUD here while `domains/workbenches` owns it. |

## Invariants

- The bootstrap transaction takes a Postgres advisory lock scoped to the user id
  so concurrent first-load requests converge.
- The personal project is selected by `projects.userId`, `isPersonal = true`,
  and `deletedAt IS NULL`.
- The default agent slug is `writer`; the default work title is `Book 1`; the
  initial thread is `kind = "primary"` and linked to the chapter document with
  `relationship = "editing"`.
- Re-running bootstrap must return the same logical bundle instead of creating a
  second personal project, manuscript source, chapter document, or editing
  thread.

## Relationship to `domains/workbenches`

`domains/workbenches` carries the copied upstream repository and owner-gate
surface: workbench CRUD, work list/search/touch, user provisioning, and
`requireWorkbenchOwner`. Route wrappers under `/api/workbenches/*` should use
that domain. Keep this `projects` domain narrow unless the bootstrap flow itself
needs to change.
