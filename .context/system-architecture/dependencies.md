# Dependencies

The map's pictures show what moves between parts. This page holds what they leave out: the rules
about who may import whom, and where the code breaks them today.

## The rules

These are the rules the repo writes down ([root CONTEXT](../CONTEXT.md)). Everything else, including
ordinary imports between apps, packages and features, is not listed anywhere.

- **Apps import packages; no package imports an app.** Nothing breaks it today.
- **A package imports only packages lower in the list on the [code](code.md) page.** `gateway`, `prosemirror-schema`, `yjs-inspect` and `design-tokens` import no workspace code.
- **Server domains are meant to be acyclic.** A domain reaches another through its public `index.ts` and ports, and threads reference project and Work ownership, never the reverse. Six domains (`runtime`, `threads`, `projects`, `file-policy`, `context`, `collab`) import each other in a cycle today.
- **Domains do not import `lib/`.** `lib/` is the composition root: it may import every domain and wire them together.
- **The app's layers (`routes`, features, `client`, `components`, `core`, `lib`) have no written rule**, and imports run both ways between them, so a feature importing another feature is not a break.
- **The agent runtime (`domains/runtime`) does not import document, billing or Work code.** Its ties are listed [below](#the-runtimes-ties-to-document-billing-and-work-code).

A new cycle edge, a new domain import of `lib/`, or a new runtime tie listed below is a regression: add a row here only for a break
that already exists, and prefer deleting one over adding a row.

## Where the code breaks them

One row per break. `from` and `to` are two domains, a domain and `lib`, or a package and an app.
In this table only value imports count: a type-only import (`import type`) or a test-only import is not a break.
The example is one importing file, not the only one. `pnpm check:architecture` fails on a break
with no row and on a row with no break.

| from | to | rule | example file |
|---|---|---|---|
| `collab` | `context` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-apply-tree.ts` |
| `collab` | `file-policy` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-drafts.ts` |
| `collab` | `projects` | domains are acyclic | `apps/server/server/domains/collab/adapters/drizzle-apply-click.ts` |
| `collab` | `runtime` | domains are acyclic | `apps/server/server/domains/collab/hocuspocus-persistence.ts` |
| `context` | `collab` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/bound-writes.ts` |
| `context` | `file-policy` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/context-fs.ts` |
| `context` | `projects` | domains are acyclic | `apps/server/server/domains/context/adapters/context-fs/context-fs.ts` |
| `context` | `threads` | domains are acyclic | `apps/server/server/domains/context/document-revisions.ts` |
| `file-policy` | `collab` | domains are acyclic | `apps/server/server/domains/file-policy/adapters/drizzle-file-facts.ts` |
| `file-policy` | `context` | domains are acyclic | `apps/server/server/domains/file-policy/adapters/drizzle-file-facts.ts` |
| `projects` | `context` | domains are acyclic | `apps/server/server/domains/projects/index.ts` |
| `runtime` | `context` | domains are acyclic | `apps/server/server/domains/runtime/loop/permissions/agent-chain.ts` |
| `runtime` | `file-policy` | domains are acyclic | `apps/server/server/domains/runtime/adapters/context-image-assets.ts` |
| `runtime` | `projects` | domains are acyclic | `apps/server/server/domains/runtime/loop/permissions/agent-chain.ts` |
| `runtime` | `threads` | domains are acyclic | `apps/server/server/domains/runtime/adapters/drizzle/permission-grants.ts` |
| `threads` | `context` | domains are acyclic | `apps/server/server/domains/threads/adapters/drizzle/repositories.ts` |
| `threads` | `projects` | domains are acyclic | `apps/server/server/domains/threads/adapters/drizzle/thread-works-repository.ts` |

## Reading the table

At run time the domains are wired through ports that `lib/` fills, so an import that carries only a
port's type is not a break and has no row. A domain importing another domain's `adapters/`
breaks no written rule; those are named in `Breaks` on the box that makes them, on the
[server](server.md) group pages.

## The runtime's ties to document, billing and Work code

Rule: **the runtime does not import document, billing or Work code.**

The agent runtime (`domains/runtime`) is to be cut free of the document, billing and Work code so another
product can use it. Until that lands it must not grow new ties, so this rule is checked per importing
file and counts type-only imports (the runtime can't be lifted out while it needs those types to
compile). Files are under `apps/server/server/domains/runtime/`; a domain is named by its last segment. Test files and test support (`*.test.*`, `__tests__`, `tests`, `fixtures`, `test-support`) don't count.
The modules are the packages `@meridian/agent-edit` and `@meridian/markup`, the subpath
`@meridian/contracts/works`, and the server domains `context`, `billing`, `projects`, `file-policy`,
`packages`, `notices` and `storage`. Delete a row when its import goes; never add one. A new file that
imports one of them fails the check.

| file | imports |
|---|---|
| `adapters/context-image-assets.ts` | `context` |
| `adapters/context-image-assets.ts` | `file-policy` |
| `adapters/context-image-assets.ts` | `storage` |
| `adapters/in-memory/observation-frontiers.ts` | `@meridian/agent-edit` |
| `adapters/runtime-delivery.ts` | `notices` |
| `admission/user-turn-admission.ts` | `context` |
| `admission/user-turn-admission.ts` | `@meridian/markup` |
| `agent-definition-support.ts` | `packages` |
| `handoff/brief-service.ts` | `billing` |
| `index.ts` | `projects` |
| `loop/available-skills.ts` | `file-policy` |
| `loop/available-skills.ts` | `packages` |
| `loop/compaction/important-files.ts` | `@meridian/agent-edit` |
| `loop/compaction/notes-step.ts` | `@meridian/agent-edit` |
| `loop/compaction-revisions.ts` | `context` |
| `loop/compaction-successor.ts` | `@meridian/agent-edit` |
| `loop/context-builder.ts` | `notices` |
| `loop/frontier-recording.ts` | `@meridian/agent-edit` |
| `loop/inbox-context.ts` | `notices` |
| `loop/orchestrator.ts` | `billing` |
| `loop/orchestrator.ts` | `context` |
| `loop/orchestrator.ts` | `packages` |
| `loop/orchestrator.ts` | `@meridian/agent-edit` |
| `loop/permissions/agent-chain.ts` | `context` |
| `loop/permissions/agent-chain.ts` | `file-policy` |
| `loop/permissions/agent-chain.ts` | `packages` |
| `loop/permissions/agent-chain.ts` | `projects` |
| `loop/reference-context.ts` | `@meridian/agent-edit` |
| `loop/run-state.ts` | `@meridian/contracts/works` |
| `loop/runtime-delivery.ts` | `notices` |
| `loop/runtime-delivery.ts` | `projects` |
| `loop/runtime-delivery.ts` | `@meridian/contracts/works` |
| `loop/skill-files.ts` | `file-policy` |
| `loop/skill-files.ts` | `packages` |
| `loop/thread-controls.ts` | `@meridian/contracts/works` |
| `loop/tool-dispatch.ts` | `@meridian/agent-edit` |
| `loop/turn-accounting.ts` | `billing` |
| `loop/turn-context-assembly.ts` | `packages` |
| `loop/work-context.ts` | `projects` |
| `loop/work-context.ts` | `@meridian/contracts/works` |
| `loop/write-mode-switch.ts` | `projects` |
| `loop/write-mode-switch.ts` | `@meridian/contracts/works` |
| `ports/observation-frontiers.ts` | `@meridian/agent-edit` |
| `ports/shown-links.ts` | `@meridian/agent-edit` |
| `ports/shown-links.ts` | `@meridian/markup` |
| `spawn/apply-invocation-patch.ts` | `packages` |
| `spawn/child-run-coordinator.ts` | `packages` |
| `spawn/resolve-child-invocation.ts` | `packages` |
| `spawn/resolve-readable-thread.ts` | `context` |
| `spawn/thread-history-contract.ts` | `@meridian/agent-edit` |
| `spawn/thread-history.ts` | `context` |
| `spawn/thread-ls.ts` | `context` |
| `summary/conversation-summarizer.ts` | `packages` |
| `tools/agent-thread-context.ts` | `packages` |
| `tools/core-tools.ts` | `@meridian/agent-edit` |
| `tools/core-tools.ts` | `@meridian/contracts/works` |
| `tools/grep-result.ts` | `context` |
| `tools/grep-result.ts` | `@meridian/agent-edit` |
| `tools/history-summaries.ts` | `@meridian/agent-edit` |
| `tools/inspection-tools.ts` | `context` |
| `tools/skill-tool.ts` | `@meridian/agent-edit` |
| `tools/types.ts` | `@meridian/agent-edit` |
