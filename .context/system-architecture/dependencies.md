# Dependencies

The map's pictures show what moves between parts, not what imports what. This page holds the other
half: the rules about who may import whom, and the places the code breaks them today.

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

One row per direction between two domains in the cycle, and one for the `lib/` import. Type-only
imports count, because the dependency exists whatever it carries; test-only imports do not. The
example is one importing file, not the only one.

| from | to | rule | example file |
|---|---|---|---|
| `collab` | `context` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-apply-click.ts` |
| `collab` | `file-policy` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-drafts.ts` |
| `collab` | `projects` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-apply-click.ts` |
| `collab` | `runtime` | domains are acyclic | `apps/server/server/domains/collab/composition.ts` |
| `context` | `collab` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/bound-writes.ts` |
| `context` | `file-policy` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/context-fs.ts` |
| `context` | `projects` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/context-fs.ts` |
| `context` | `runtime` | domains are acyclic | `apps/server/server/domains/context/tree/hidden-node-repair.ts` |
| `context` | `threads` | domains are acyclic | `apps/server/server/domains/context/adapters/owner-lookup.ts` |
| `file-policy` | `collab` | domains are acyclic | `apps/server/server/domains/file-policy/adapters/drizzle-file-facts.ts` |
| `file-policy` | `context` | domains are acyclic | `apps/server/server/domains/file-policy/adapters/drizzle-file-facts.ts` |
| `file-policy` | `projects` | domains are acyclic | `apps/server/server/domains/file-policy/adapters/drizzle-file-facts.ts` |
| `projects` | `collab` | domains are acyclic | `apps/server/server/domains/projects/index.ts` |
| `projects` | `context` | domains are acyclic | `apps/server/server/domains/projects/adapters/work-cascade.ts` |
| `projects` | `file-policy` | domains are acyclic | `apps/server/server/domains/projects/adapters/work-repository/drizzle.ts` |
| `runtime` | `context` | domains are acyclic | `apps/server/server/domains/runtime/adapters/context-image-assets.ts` |
| `runtime` | `file-policy` | domains are acyclic | `apps/server/server/domains/runtime/adapters/context-image-assets.ts` |
| `runtime` | `projects` | domains are acyclic | `apps/server/server/domains/runtime/index.ts` |
| `runtime` | `threads` | domains are acyclic | `apps/server/server/domains/runtime/adapters/drizzle-handoff-status-reader.ts` |
| `threads` | `context` | domains are acyclic | `apps/server/server/domains/threads/adapters/drizzle/repositories.ts` |
| `threads` | `projects` | domains are acyclic | `apps/server/server/domains/threads/adapters/drizzle/repositories.ts` |
| `runtime` | `lib` | domains do not import `lib/` | `apps/server/server/domains/runtime/gateway/config/create-from-env.ts` |

## Reading the table

Eight pairs import each other (`collab` and `context`, `collab` and `file-policy`, `collab` and
`projects`, `context` and `file-policy`, `context` and `projects`, `file-policy` and `projects`,
`runtime` and `context`, `threads` and `context`), which is 16 rows; five one-way imports (`collab` to
`runtime`, `runtime` to `file-policy`, `runtime` to `projects`, `runtime` to `threads`, and `threads` to `projects`) make 21. At run
time the domains are wired through ports that `lib/` fills, so many of these imports are type-only (a
port's type) and the call goes through `lib`. Cross-domain imports of another domain's `adapters/`
(eight today) are named in the `Breaks` of the box that makes them on the [server](server.md) child
pages; they are not a written rule.
