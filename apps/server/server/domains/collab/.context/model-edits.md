# Model edits as commands

Built in M10 part 2a beside the held writes ([design](https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/document-commands/design.md)); nothing in production sets `ctx.modelEdit` until the loop part lands, so the thread-peer pool still serves every call.

A model's document-changing tool call (`write`: text, `undo`/`redo`/`revert`, `move`, `delete`, `create`, `copy`) is one command, keyed by `modelEditIds(key)` (`shared/model-edit-ids.ts`: response id and tool-call id, so a retry and a recovering process derive the same id).

- `modelEdits().run` opens the command transaction, claims the id as its first write (`runCommandWithinTx`), runs the effect in the part 1 savepoint and stores the tool result with the outcome. The effect throws `ModelEditRefusal` to answer without changing anything. A repeat of a settled key answers the stored outcome. `run` refuses an ambient transaction.
- `modelEdits().resolve` is for a caller that stopped waiting: it inserts `never` with `ON CONFLICT DO NOTHING` (which waits on a transaction still holding the key), then reads the row.
- `modelEdits().write` is the one operation that reads, plans, lowers and appends under the lock the append takes: live, the seam's Work locks then the document lock; a Work draft, the grants' Works, `approveBranchWriteJoin`, the branch, `ensureDocumentDraft`, the closed-draft rule, then the draft row `FOR UPDATE`. A writer's keystroke into the document waits for one edit's planning and append.
- `modelEdits().catchUp` is the draft's live pull. A pull opens a connection of its own, so the handler runs it before the claim.

## One connection

The edit holds its document's lock while it plans, so a second connection waiting on a lock the first holds would never return. The transaction marks itself (`joinRootTransactionsInAmbient`): a root transaction or read snapshot opened under it runs inside it. What cannot join moved:

| Step | Where it went |
|---|---|
| Room read (`committedCopy`) stepped outside the transaction | reads inside it while `inLockedWrite()` |
| Draft live pull in `readRoom` | `catchUp`, before the claim |
| Ahead-ref registration (`register` throws in a transaction) | `registerInCommand`: namespace keys taken on the command's connection, after the document lock, so a deadlock with a tree command is possible and Postgres aborts one side |
| `runInRootDrizzleReadSnapshot` in the model undo's capture and in address resolution | join the command transaction |

Receipts (`document_edits.command_id`) take the id from `bindEditsToCommand`, bound by `run`, so text and tree receipts of one command share it without each writer passing it.
