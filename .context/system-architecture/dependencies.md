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

A new cycle edge, a new domain import of `lib/`, or a new runtime tie listed below is a regression: add a row here only for a break
that already exists, and prefer deleting one over adding a row.

## Where the code breaks them

One row per break. `from` and `to` are two domains, a domain and `lib`, or a package and an app.
In this table only value imports count: a type-only import (`import type`) or a test-only import is not a break.
The example is one importing file, not the only one. `pnpm check:architecture` fails on a break
with no row and on a row with no break.

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

## The runtime's ties to document, billing and Work code

The agent runtime (`domains/runtime`) is to be cut free of the document, billing and Work code so another
product can use it. Until that lands it must not grow new ties, so this rule is checked per importing
file and counts type-only imports (the runtime can't be lifted out while it needs those types to
compile). Test files and test support (`*.test.*`, `__tests__`, `tests`, `fixtures`, `test-support`) don't count.
The modules are the packages `@meridian/agent-edit` and `@meridian/markup`, the subpath
`@meridian/contracts/works`, and the server domains `context`, `billing`, `projects`, `file-policy`,
`packages`, `notices` and `storage`. Delete a row when its import goes; never add one. A new file that
imports one of them fails the check.

| file | imports | rule |
|---|---|---|
| `apps/server/server/domains/runtime/adapters/context-image-assets.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/adapters/context-image-assets.ts` | `apps/server/server/domains/file-policy` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/adapters/context-image-assets.ts` | `apps/server/server/domains/storage` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/adapters/in-memory/observation-frontiers.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/adapters/runtime-delivery.ts` | `apps/server/server/domains/notices` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/admission/user-turn-admission.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/admission/user-turn-admission.ts` | `@meridian/markup` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/agent-definition-support.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/handoff/brief-service.ts` | `apps/server/server/domains/billing` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/index.ts` | `apps/server/server/domains/projects` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/available-skills.ts` | `apps/server/server/domains/file-policy` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/available-skills.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/compaction/important-files.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/compaction/notes-step.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/compaction-revisions.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/compaction-successor.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/context-builder.ts` | `apps/server/server/domains/notices` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/frontier-recording.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/inbox-context.ts` | `apps/server/server/domains/notices` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/orchestrator.ts` | `apps/server/server/domains/billing` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/orchestrator.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/orchestrator.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/orchestrator.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/permissions/agent-chain.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/permissions/agent-chain.ts` | `apps/server/server/domains/file-policy` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/permissions/agent-chain.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/permissions/agent-chain.ts` | `apps/server/server/domains/projects` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/reference-context.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/run-state.ts` | `@meridian/contracts/works` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/runtime-delivery.ts` | `apps/server/server/domains/notices` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/runtime-delivery.ts` | `apps/server/server/domains/projects` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/runtime-delivery.ts` | `@meridian/contracts/works` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/skill-files.ts` | `apps/server/server/domains/file-policy` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/skill-files.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/thread-controls.ts` | `@meridian/contracts/works` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/tool-dispatch.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/turn-accounting.ts` | `apps/server/server/domains/billing` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/turn-context-assembly.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/work-context.ts` | `apps/server/server/domains/projects` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/work-context.ts` | `@meridian/contracts/works` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/write-mode-switch.ts` | `apps/server/server/domains/projects` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/loop/write-mode-switch.ts` | `@meridian/contracts/works` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/ports/observation-frontiers.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/ports/shown-links.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/ports/shown-links.ts` | `@meridian/markup` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/spawn/apply-invocation-patch.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/spawn/child-run-coordinator.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/spawn/resolve-child-invocation.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/spawn/resolve-readable-thread.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/spawn/thread-history-contract.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/spawn/thread-history.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/spawn/thread-ls.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/summary/conversation-summarizer.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/agent-thread-context.ts` | `apps/server/server/domains/packages` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/core-tools.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/core-tools.ts` | `@meridian/contracts/works` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/grep-result.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/grep-result.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/history-summaries.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/inspection-tools.ts` | `apps/server/server/domains/context` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/skill-tool.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
| `apps/server/server/domains/runtime/tools/types.ts` | `@meridian/agent-edit` | the runtime does not import document, billing or Work code |
