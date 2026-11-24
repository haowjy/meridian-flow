# Invariants: how each is kept

Three rules the whole system keeps, each with why writers rely on it, how the code keeps it
today, what checks it, and where it falls short. The mechanisms
are current choices; the invariant is what they serve.

## Text merges through Loro

The writer and the model edit the same document at once. Their concurrent edits merge the
way Loro merges, so every copy that has seen the same edits shows the same text. This is not a
promise that no edit is ever overwritten: Apply is "later action wins" by design. The rule
is that an overwrite, a repair or an undo is itself an ordinary edit, which every copy
receives and the history keeps.

**How.** A document is a Loro room: a structure doc and a text doc per block
(`packages/document-model`). A tab's batch is imported into the loaded room as sent, relayed and
acked, and the room saves the docs it changed as `document_snapshots` rows within seconds
(`apps/server/server/domains/collab/rooms/postgres-document-rooms.ts`). A model's write commits
its batch with its receipt in its command's transaction and reaches the loaded room after commit.
A tab whose acked batch the server lost in a restart resends it at its next Join, since the room's
version lacks it. A room past about 5 MB cuts history older than 7 days on unload; a batch that
depends on history below the cut ends its room (`history-cutoff`). Contracts:
`apps/server/server/domains/collab/.context/CONTEXT.md` and
`websocket-concurrency.md` beside it.

**Checked by** `packages/loro-prosemirror/.context/qa/two-editors.probe.ts` (two editors on one
room), `tools/qa/probes/history-compaction/run.mts`, and the collab DB tests on real Postgres.

**Gaps.** No test shuffles deliveries through the room server or spans the write paths (a tab,
a model edit, Apply, import).

One path changes text on one copy with no edit the others receive:

- **Schema repair while projecting.** `deriveDocument`
  (`apps/server/server/domains/collab/domain/document-derivations.ts`) and `projectBlocks`
  (`packages/agent-edit/src/model/loro-model.ts`) drop a node the schema cannot represent from
  what they read and append nothing. What the model reads can omit text the stored document
  still holds.

Import seeds a new document's first rows; that is creation, not an edit.

## Writer text stays out of logs and diagnostics

**How.** Every event passes one sanitizer at the sink boundary
(`apps/server/server/domains/observability/safe-event.ts`): an allowlist of keys, bounded
strings and a size cap. Model request bodies go only to a bounded in-memory debug store,
never on in production. The dev wire tap of the Loro room socket
(`apps/app/src/features/debug/trace/loro-wire-tap.ts`) records a frame's class, size and batch id,
never its updates.
Reasons: the KB's `wiki/architecture/diagnostics.md`.

**Checked by** `safe-event.test.ts` and `apps/server/server/lib/env.test.ts`.

**Gaps.** Nothing checks what emit sites pass, nor that the wire tap stays content-free. Only `DeferredEventSink` sanitizes, so a
sink built without it writes raw payloads. `errorMessage` is free text by design.

## Receipts say truthfully who did what

**How.** Every edit, undo, revert and rollback writes an immutable receipt naming its actor
(`document_edits`); an inverse is an ordinary forward edit with its own receipt. A model's change
carries its turn in the Loro change's commit message (`commitMessage`'s `by`), which is how a later write
reports who changed what since a read. The message also says when the change was made in a draft,
so a copy that imports it into Live through an Apply does not credit the turn with a write there.
Every authored commit goes through `RoomDocs.commit`, which takes the draft flag from the copy. Contracts:
`apps/server/server/domains/collab/.context/reversal.md`; reasons: the KB's
`wiki/architecture/collaboration/turn-receipts.md`.

**Checked by** the collab DB tests: `inverse-attribution`, `model-inverse` and
`turn-inverse`.

**Gaps.** What the browser displays is unchecked. Cut-and-pasted text reads as the writer's
(#889). Five receipt families have separate shapes, and nothing cross-checks them.
