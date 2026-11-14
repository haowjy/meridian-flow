# Model edits as commands

Built in M10 part 2a ([design](https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/document-commands/design.md)); the runtime's executor sets `ctx.modelEdit` for every `documentCommand` call (part 2b), so these are the production path. Nothing holds a write for a later save: the held machinery (response committer, thread-peer pool, response write lifecycle) is gone (part 2c).

A model's document-changing tool call (`write`: text, `undo`/`redo`/`revert`, `move`, `delete`, `create`, `copy`) is one command, keyed by `modelEditIds(key)` (`shared/model-edit-ids.ts`: response id and tool-call id, so a retry and a recovering process derive the same id).

- `modelEdits().run` opens the command transaction, claims the id as its first write (`runCommandWithinTx`), runs the effect in the part 1 savepoint and stores the tool result with the outcome. The effect throws `ModelEditRefusal` to answer without changing anything. A repeat of a settled key answers the stored outcome. `run` refuses an ambient transaction.
- `modelEdits().resolve` is for a caller that stopped waiting: it inserts `never` with `ON CONFLICT DO NOTHING` (which waits on a transaction still holding the key), then reads the row. It joins an ambient transaction and opens none: runtime recovery calls it inside the finalizer's thread-lock transaction, where a connection of its own would wait on the lock the first holds. The edit's own transaction takes no thread lock, so waiting on its key cannot deadlock.
- `modelEdits().write` is the one operation that reads, plans, lowers and appends under the lock the append takes: live, the seam's Work locks then the document lock; a Work draft, the grants' Works, `approveBranchWriteJoin`, the branch, `ensureDocumentDraft`, the closed-draft rule, then the draft row `FOR UPDATE`. A writer's keystroke into the document waits for one edit's planning and append.
- `modelEdits().catchUp` is the draft's live pull. A pull opens a connection of its own, so the handler runs it before the claim.

## One connection

The edit holds its document's lock while it plans, so a second connection waiting on a lock the first holds would never return. The transaction marks itself (`joinRootTransactionsInAmbient`): a root transaction or read snapshot opened under it runs inside it. What cannot join moved:

| Step | Where it went |
|---|---|
| Room read (`committedCopy`) stepped outside the transaction | reads inside it while `inLockedWrite()` |
| Draft live pull in `readRoom` | `catchUp`, before the claim |
| Ahead-ref registration (`register` throws in a transaction) | `registerInCommand`: namespace keys taken on the command's connection, after the document lock, so a deadlock with a tree command is possible and Postgres aborts one side |
| Link-derivation flush before a move (`flushMoveLinks`; the mover would run it on connections of its own) | before the claim; the move passes `linksFlushed` |
| `runInRootDrizzleReadSnapshot` in the model undo's capture and in address resolution | join the command transaction |

Receipts (`document_edits.command_id`) take the id from `bindEditsToCommand`, bound by `run`, so text and tree receipts of one command share it without each writer passing it.

## What the model was shown

`modelEvidence()` (`ModelEvidence`) keeps `observation_frontiers` and `thread_shown_links`; the runtime reaches it through its `DocumentEvidence` port, and its own transactions write none of it.

- An edit's effect returns its evidence, and `run` records it inside the command, under `modelEditIds(key).blockId` and the call's thread and turn. A refused edit records none; what its answer showed rides back in memory like a read's, and the runtime hands it on once the block is stored. A crash after the commit or a timeout loses nothing.
- A read's evidence is handed over with `resultStored` after the runtime stores the block. Only a returned value is handed on, so a handler that outlived its timeout attaches nothing.
- The closed-draft admission rule asks collab's own `latestRoom`, among the block ids the runtime names in `creditedBlockIds`. The runtime's other lookups (`recording`, `planning`) go through the port limited to the same kind of block ids.
- `forgetThreads` deletes both tables' rows for the threads a Work purge removes; `project_id` cascades a deleted project.
