# Crash test of the model's edits

The model's document edits must survive a process death at any step: the document text, the
`document_edits.command_id` receipts, the stored result blocks, the `document_commands` rows and
the evidence rows (observation frontiers) each end up exactly once ([design][design],
[model edits](../model-edits.md), [recovery](../../../runtime/.context/recovery.md)).

```sh
pnpm test:probes model-edit-kills model-edit-takeover model-edit-drafts model-edit-tree model-edit-evidence
```

(`pnpm test:probes` runs every `tools/qa/probes/<name>/run.mts`, as CI does; names pick some.) Each
probe makes and drops its own `lfd_probe_*` database and runs in under a minute.

| Probe | What it kills or holds |
|---|---|
| `model-edit-kills` | A write to a live document at each step: before the response is stored, before and after the claim, before and after the commit, around the result block, between two calls, an old process held alive, a repeated key, a tool timeout before and after the claim. |
| `model-edit-takeover` | A stale process storing a response or a result block after its run was taken over; the sweep; recovery waiting on a held key; two chats on one document; a chat card's Undo sent twice after a kill. |
| `model-edit-drafts` | The same steps in draft mode, plus a writer typing during the edit, a Discard between two calls, a write after a Discard, a new draft after a Discard, two chats on one Work's draft. |
| `model-edit-tree` | `move`, `delete`, `create`, `copy` and the model's `undo` killed after commit; a refused `create`; an aborted `create`; a duplicate call id; all four tree calls in a draft-mode chat. |
| `model-edit-evidence` | What the model was shown: an edit's frontier survives a kill after commit, a read's is lost between its block and `resultStored`. |

## The harness

`tools/qa/probes/model-edit-harness/`:

- `child.mts` is one composed server: production ports and services over the scratch database
  with a pool of `max: 2` (a second connection held under a lock hangs the probe instead of
  production), the mock model, and the Hocuspocus gateway. The parent drives it with JSON lines
  on stdin: queue a scripted reply, arm a test hook point, send a message, run the recovery
  lanes once, resolve a key, send a card's Undo, Discard a Work's branch, shorten a tool's
  timeout.
- `harness.mts` is the parent: it seeds a Work, chats and documents by SQL, bundles the child
  with esbuild (a tsx boot takes 8 s, the bundle 1 s), spawns children, and asserts on rows
  (`state`, `drafts`, `frontierSources`).

A case sends a message as the writer, so the run starts as the chat route starts it (admission,
inbox, run claim, orchestrator). The mock model's replies are scripted per response, with each
tool call's `id` fixed so assertions name the call. A command's id comes from the stored
response's id and the call id, so cases share no command rows.

- **Kill**: arming a point with `kill` makes the child `SIGKILL` itself on arrival. The session
  lock is freed by the death, as in production.
- **Hold**: arming with `hold` parks the operation at the point, with the locks it holds, until
  `release`. The old process stays alive while a second one recovers.
- **Lost claim**: `dropRunClaim` terminates the backend that holds a child's session advisory
  lock, as a dropped connection does, so a second process can take over a chat whose first
  process is alive.
  A child whose claim was cut dies with an uncaught `TypeError` from `postgres.js` when it next
  uses the reserved session connection (the library writes to a closed socket from a timer; no
  promise rejects). The takeover cases kill such a child instead of stopping it cleanly.
- **Takeover**: a second child runs `sweep` (orphan repair and wake scan), the real recovery.

`CASE=<text>` runs only the cases whose name contains it.

Hook points are in `shared/test-hooks.ts`: `response.beforeStore`, `command.*`,
`draft.append.beforeCommit`, `block.*` and `recovery.beforeResolve`. `command.afterCommit` also
fires after a top-level `DocumentCommands.run` (a chat card's Undo).

The pool of 2 means a held transaction and the session lock use both connections, so a second
operation in the same child waits for a connection, not for a database lock. A case that needs
two edits at once starts a second child.

[design]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/document-commands/design.md
