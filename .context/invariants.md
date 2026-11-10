# Invariants: how each is kept

The root `AGENTS.md` states each invariant and why writers rely on it. This page says
how the code keeps it today, what checks it, and where it falls short. The mechanisms
are current choices; the invariant is what they serve.

## Writer data survives

**How.** A release with pending migrations needs a confirmed backup first (the KB's
`wiki/architecture/hosting.md`). `tools/dev/migration-lint.ts` rejects unsafe DDL (a `NOT NULL` column without a
default, a rename, a drop without a lock timeout, a non-concurrent index, an unbounded
`UPDATE` or `DELETE`). `tools/dev/check-migration-history.ts` freezes merged history,
and the migration runner refuses an inconsistent ledger. CI runs both; lefthook runs
the lint on staged files. Rules: `packages/database/.context/CONTEXT.md` (Migration
integrity); reasons: the KB's `wiki/conventions/practice/database-migrations.md`.

**Checked by** `tools/dev/migration-lint.test.ts`,
`tools/dev/lib/migration-history.test.ts`, `tools/dev/lib/migration-runner.db.test.ts`
and `packages/database/src/fresh-migrations.db.test.ts`, which replays migrations over
seeded rows.

**Gaps.** The lint isn't part of `pnpm check`. A `-- migration-lint: skip <RULE>` needs no
reason, and nothing checks that a skip doesn't assume empty tables. The rules are
regular expressions, so a vacuous `WHERE true` passes. `tools/dev/.context/CONTEXT.md`
says the `0000_` baseline is exempt from warnings only; the lint skips every rule there.
The backup mechanism isn't chosen yet, and database functions are applied after
migrations commit, so `consume_credit_lots_fifo` can be missing mid-deploy (#589).

## Text converges

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
