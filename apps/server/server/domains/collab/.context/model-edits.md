# Model edits as commands

Built in M10 part 2a ([design](https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/document-commands/design.md)); the runtime's executor sets `ctx.modelEdit` for every `documentCommand` call (part 2b), so these are the production path. Nothing holds a write for a later save: the held machinery (response committer, thread-peer pool, response write lifecycle) is gone (part 2c).

A model's document-changing tool call (`write`: text, `undo`/`revert`, `move`, `delete`, `create`, `copy`) is one command, keyed by `modelEditIds(key)` (`shared/model-edit-ids.ts`: response id and tool-call id, so a retry and a recovering process derive the same id).

- `modelEdits().run` is `runCommand`: it opens the command transaction, claims the id as its first write, runs the effect in the part 1 savepoint and stores the tool result with the outcome. The effect throws `ModelEditRefusal` to answer without changing anything (an error result: `invalid_write`, `binary_file`, a path that never existed). An edit that cannot land because what it edits changed is not an error: it is a plain `done` row with `settled: [{ rule: "returned", why }]` (`document_removed`, `work_archived`, `work_deleted`, `block_gone`), and its result carries the document as the chat reads it now. A repeat of a settled key answers the stored outcome. `run` refuses an ambient transaction.
- `modelEdits().resolve` is for a caller that stopped waiting: it inserts `never` with `ON CONFLICT DO NOTHING` (which waits on a transaction still holding the key), then reads the row. It joins an ambient transaction and opens none: runtime recovery calls it inside the finalizer's thread-lock transaction, where a connection of its own would wait on the lock the first holds. The edit's own transaction takes no thread lock, so waiting on its key cannot deadlock.
- `modelEdits().write` is the one operation that reads, plans, lowers and appends under the lock the append takes: live, the seam's Work locks then the document lock; a Work draft, the grants' Works, the removed-document rule (before any branch or draft opens: a removed document returns the edit and makes none), `approveBranchWriteJoin`, the branch, `ensureLiveDocumentDraft` (the live journal read in the transaction, no room mutex), then the draft row `FOR UPDATE`. A writer's keystroke into the document waits for one edit's planning and append.
- In suggestion mode (`FLOW_SUGGESTIONS=1`), a drafted write is no draft: it runs under the Live document's lock on `workView(work, author).core`, which writes into Live as that Work's suggestions (`packages/suggestions`). A drafted read, and the effective reader's reads for a Work, go through the same `workView`. An `undo`/`revert` keeps its own path; card Undo of a turn that left suggestions rejects them (`suggestion-turn-undo.ts`).
- `modelEdits().read` is a read inside a `run` effect (the text a returned edit shows): it joins the command's transaction and pulls nothing, as a write's room read does.
- A server failure (an apply or commit that failed, an effect that threw) is not the model's to retry: `effectSettler` (`lib/model-tools/document-tools.ts`) runs the effect once more under the same command id, and only a second failure is answered, as an edit that did not land and asks for no retry. What an effect leaves in memory outlives its rollback, so each attempt starts from a checkpoint of the reply's own updates (`ReplyMutations.checkpoint`) and a rolled-back one restores it; captured call inputs (a Copy's source nodes) stay immutable and each attempt derives its own.
- `modelEdits().catchUp(documentId, threadId)` is the thread's Work draft's catch-up with live (nothing when the thread has no draft of the document). A pull opens a connection of its own, so the handler runs it before the claim.

## One connection

The edit holds its document's lock while it plans, so a second connection or a process mutex waiting on a lock the first holds would never return, and Postgres would not see it. Every command shares this rule and its guard (`CONTEXT.md`, the lock order): a root transaction or read snapshot opened under `runInCommandTransaction` runs inside it, and in dev and test a `KeyedMutex` or a second connection throws. What cannot join moved:

| Step | Where it went |
|---|---|
| Room read (`committedCopy`) stepped outside the transaction | reads inside it while `inLockedWrite()` |
| A drafted first write's draft, made from the live room under `withDocument` | `ensureLiveDocumentDraft`: the live journal read in the transaction, after the Work, under the document key |
| Draft live pull in `readRoom` | `catchUp`, before the claim |
| Ahead-ref registration (`register` throws in a transaction) | `registerInCommand`: namespace keys taken on the command's connection, after the document lock: the one place the order is reversed, because the refs a write mints are known only while it plans (lock order in `CONTEXT.md`) |
| `runInRootDrizzleReadSnapshot` in address resolution | joins the command transaction |
| The model undo's capture snapshot | the capture plans off the locks; the commit plans each step again under them and the answer reports what it took (`CommittedInverse.taken`) |

Receipts (`document_edits.command_id`) take the id from `bindEditsToCommand`, bound by `run`, so text and tree receipts of one command share it without each writer passing it.

## What the model was shown

`modelEvidence()` (`ModelEvidence`) keeps `observation_frontiers` and `thread_shown_links`; the runtime reaches it through its `DocumentEvidence` port, and its own transactions write none of it.

- An edit's effect returns its evidence, and `run` records it inside the command, under `modelEditIds(key).blockId` and the call's thread and turn. A returned edit records the evidence of the text it showed in the same row. An error result records none; what its answer showed rides back in memory like a read's, and the runtime hands it on once the block is stored. A crash after the commit or a timeout loses nothing.
- A read's evidence is handed over with `resultStored` after the runtime stores the block. Only a returned value is handed on, so a handler that outlived its timeout attaches nothing.
- `forgetThreads` deletes both tables' rows for the threads a Work purge removes; `project_id` cascades a deleted project.
