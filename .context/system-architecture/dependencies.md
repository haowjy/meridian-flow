# Dependencies

The map's pictures show what moves between parts. This page holds what they leave out: the rules
about who may import whom, and where the code breaks them today.

## The rules

These are the rules the repo writes down ([root CONTEXT](../CONTEXT.md)). Everything else, including
ordinary imports between apps, packages and features, is not listed anywhere.

- **Apps import packages; no package imports an app.** Nothing breaks it today.
- **A package imports only packages lower in the list on the [code](code.md) page.** `contracts`, `prosemirror-schema`, `yjs-inspect` and `design-tokens` import no workspace code.
- **Server domains are meant to be acyclic.** A domain reaches another through its public `index.ts` and ports, and threads reference project and Work ownership, never the reverse. Six domains (`runtime`, `threads`, `projects`, `file-policy`, `context`, `collab`) import each other in a cycle today.
- **Domains do not import `lib/`.** `lib/` is the composition root: it may import every domain and wire them together.
- **The app's layers (`routes`, features, `client`, `components`, `core`, `lib`) have no written rule**, and imports run both ways between them, so a feature importing another feature is not a break.

A new cycle edge, or a new domain import of `lib/`, is a regression: add a row here only for a break
that already exists, and prefer deleting one over adding a row.

## Where the code breaks them

One row per break, and the check compares the rows with the breaks it finds, one to one: a break
with no row fails, and so does a row that matches no break. `from` and `to` are single domains, a
domain and `lib`, or a package and an app. `rule` is one of `domains are acyclic`, `domains do not
import lib/`, `packages do not import apps`. Only value imports count: a cycle is run-time coupling, so
a type-only import (`import type`) and a test-only import are not breaks. The example is one importing
file, not the only one.

| from | to | rule | example file |
|---|---|---|---|
| `collab` | `context` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-apply-click.ts` |
| `collab` | `file-policy` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-drafts.ts` |
| `collab` | `projects` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-apply-click.ts` |
| `collab` | `runtime` | domains are acyclic | `apps/server/server/domains/collab/hocuspocus-persistence.ts` |
| `context` | `collab` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/bound-writes.ts` |
| `context` | `file-policy` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/context-fs.ts` |
| `context` | `projects` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/context-fs.ts` |
| `context` | `runtime` | domains are acyclic | `apps/server/server/domains/context/tree/hidden-node-repair.ts` |
| `context` | `threads` | domains are acyclic | `apps/server/server/domains/context/document-revisions.ts` |
| `file-policy` | `collab` | domains are acyclic | `apps/server/server/domains/file-policy/adapters/drizzle-file-facts.ts` |
| `file-policy` | `context` | domains are acyclic | `apps/server/server/domains/file-policy/adapters/drizzle-file-facts.ts` |
| `projects` | `context` | domains are acyclic | `apps/server/server/domains/projects/adapters/work-cascade.ts` |
| `runtime` | `context` | domains are acyclic | `apps/server/server/domains/runtime/loop/permissions/agent-chain.ts` |
| `runtime` | `file-policy` | domains are acyclic | `apps/server/server/domains/runtime/adapters/context-image-assets.ts` |
| `runtime` | `projects` | domains are acyclic | `apps/server/server/domains/runtime/loop/permissions/agent-chain.ts` |
| `runtime` | `threads` | domains are acyclic | `apps/server/server/domains/runtime/adapters/drizzle/permission-grants.ts` |
| `threads` | `context` | domains are acyclic | `apps/server/server/domains/threads/adapters/drizzle/repositories.ts` |
| `threads` | `projects` | domains are acyclic | `apps/server/server/domains/threads/adapters/drizzle/thread-works-repository.ts` |
| `runtime` | `lib` | domains do not import lib/ | `apps/server/server/domains/runtime/gateway/config/create-from-env.ts` |

## Reading the table

At run time the domains are wired through ports that `lib/` fills, so an import that carries only a
port's type is not a break and has no row. A domain importing another domain's `adapters/`
breaks no written rule; those are named in `Breaks` on the box that makes them, on the
[server](server.md) group pages.
