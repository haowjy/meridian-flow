# Invariants: how each is kept

The root `AGENTS.md` states each invariant and why writers rely on it. This page says
how the code keeps it today, what checks it, and where it falls short. The mechanisms
are current choices; the invariant is what they serve.

## Text merges through Yjs

The writer and the model edit the same document at once. Their concurrent edits merge the
way Yjs merges, so every copy that has seen the same edits shows the same text. This is not a
promise that no edit is ever overwritten: Apply is "later action wins" by design. The rule
is that an overwrite, a repair or an undo is itself an ordinary edit, which every copy
receives and the history keeps.

**How.** An edit is appended to the document's journal before it is applied, broadcast
or acknowledged, under a per-document lock and admission sequence
(`apps/server/server/domains/collab/hocuspocus-persistence.ts`, `adapters/drizzle-journal.ts`).
A cold load replays the journal above the last checkpoint, and checkpoints come only
from the journal. Server documents keep Yjs history (`gc: false`). Mechanism and reasons:
the KB's `wiki/architecture/collaboration/durability-and-honest-outcomes.md`; contracts:
`apps/server/server/domains/collab/.context/CONTEXT.md`.

**Checked by** `apps/server/server/domains/collab/text-convergence.test.ts` (shuffled
deliveries through the production admission path), `hocuspocus-persistence.test.ts`,
`apps/server/server/lib/routes/yjs-reconnect.test.ts`, and the draft race tests on real
Postgres.

**Gaps.** The convergence test uses the in-memory journal, not Postgres. Nothing checks
`gc: false`. Five write paths (live, draft, reply save, Apply, import) each have their
own tests; none spans them. Open: #691 and #680.

Two paths change text on one copy with no edit the others receive:

- **Schema repair while projecting.** `deriveDocument`
  (`apps/server/server/domains/collab/domain/document-derivations.ts`) and `projectBlocks`
  (`packages/agent-edit/src/model/y-prosemirror.ts`) drop an element the schema cannot
  represent from a private copy and append nothing. What the model reads can omit text the
  stored document still holds.
- **Checkpoint restore.** `apps/server/server/domains/collab/checkpoints.ts` and
  `adapters/drizzle-document-authority-head.ts` install a checkpoint's state as a new
  generation and disconnect the old one. Edits made after that checkpoint are gone, not
  undone by a recorded edit.

Import seeds a new document as its first checkpoint; that is creation, not an edit.

## Writer text stays out of logs and diagnostics

**How.** Every event passes one sanitizer at the sink boundary
(`apps/server/server/domains/observability/safe-event.ts`): an allowlist of keys, bounded
strings and a size cap. Model request bodies go only to a bounded in-memory debug store,
never on in production. `packages/yjs-inspect` summarises Yjs frames as metadata.
Reasons: the KB's `wiki/architecture/diagnostics.md`.

**Checked by** `safe-event.test.ts`, the content canary in
`packages/yjs-inspect/src/inspect.test.ts`, and `apps/server/server/lib/env.test.ts`.

**Gaps.** Nothing checks what emit sites pass. Only `DeferredEventSink` sanitizes, so a
sink built without it writes raw payloads. `errorMessage` is free text by design.

## Marks and receipts say truthfully who did what

**How.** Draft review attributes changes in the browser with
`packages/agent-edit/src/diff/attribution.ts`. Every edit, undo, redo, revert and
rollback writes an immutable receipt naming its actor (`document_edits`); an inverse
is an ordinary forward edit with its own receipt. Apply records its settlement in one
commit. Contracts: `apps/server/server/domains/collab/.context/reversal.md` and
`apply.md`; reasons: the KB's `wiki/architecture/collaboration/draft-review.md` and
`turn-receipts.md`.

**Checked by** `packages/agent-edit/src/diff/attribution.test.ts` and the collab DB
tests: `inverse-attribution`, `model-inverse`, `turn-inverse`, `response-rollback`,
`draft-disposition` and `branch-tree.apply-placement`.

**Gaps.** What the browser displays is unchecked. Live documents carry no marks.
`packages/agent-edit/src/diff/item-authorship.ts` has no caller. Cut-and-pasted text
reads as the writer's (#889). Five receipt families have separate shapes, and nothing
cross-checks them.
