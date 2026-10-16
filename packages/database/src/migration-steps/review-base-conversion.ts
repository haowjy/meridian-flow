/**
 * Data step "review-base-conversion", registered by the migration runner to run immediately before the
 * migration that drops `live_cut`, the only copy of the baseline a pre-`review_base` prose draft's
 * base derives from. Its identity is the marker `-- data-step: review-base-conversion@1` on the first
 * line of that migration; changing conversion semantics means a new version and so a new marker.
 *
 * One predicate (`ELIGIBLE_BRANCH_PREDICATE`) selects the rows to convert, and the destructive
 * migration's guard embeds the same text: an active `work_draft` branch with no `base_revision`.
 * Closed branches are terminal: the only code that ever reopened one was 0044's one-time repair, and
 * no runtime path sets a `work_draft` branch back to `active`. Work deletion leaves its drafts and
 * branches active, so a soft-deleted Work's drafts are in the set.
 *
 * Each row is converted in one compare-and-swap against its full prior `state` (a state-vector compare
 * would miss delete-only changes). The step is restartable: a converted row has a `base_revision`. Failures
 * name database, document and branch ids, never prose, and say to repair or recover the baseline.
 */

import { convertLegacyDraft, UNKNOWN_BASE_REVISION } from "@meridian/agent-edit/diff";
import type postgres from "postgres";

export const REVIEW_BASE_CONVERSION_STEP_ID = "review-base-conversion";

/** Table alias `b` is `document_branches`. Shared verbatim by the converter and the B3 guard. */
export const ELIGIBLE_BRANCH_PREDICATE =
  "b.kind = 'work_draft' AND b.status = 'active' AND b.base_revision IS NULL";

/** The migration that creates `branch_push_settlement_batches`; before it ran there are no batches. */
const SETTLEMENT_BATCHES_MIGRATION = "0044_work_branch_foundation";

const BATCH = 100;
const MAX_CAS_ATTEMPTS = 3;
const MAX_REPORTED = 20;

type EligibleRow = {
  id: string;
  document_id: string;
  draft_id: string;
  state: Buffer;
  live_cut: Buffer | null;
  journaled: boolean;
};

export type ReviewBaseConversionSummary = { scanned: number; converted: number };

export interface DataStepContext {
  databaseName: string;
  /** True when the migration with this tag has already been applied to the database. */
  hasApplied(tag: string): boolean;
}

/** Names a row for operators. Identifiers only: draft prose must never reach logs. */
function rowIdentity(databaseName: string, row: EligibleRow): string {
  return `database ${databaseName}, document ${row.document_id}, branch ${row.id}, draft ${row.draft_id}`;
}

const SELECT_ROW = (sql: postgres.Sql) => sql`
  SELECT b.id, b.document_id, b.draft_id, b.state, b.live_cut,
    EXISTS (SELECT 1 FROM branch_write_journal j WHERE j.branch_id = b.id) AS journaled
  FROM document_branches b`;

/**
 * Read-only. Every settlement batch still pending or blocked is legacy whatever its members: this
 * release changes the member protocol and the `draft_tree` payload, and ships no decoder for the old
 * ones. Runs before the first pending migration of the run, so a refusal leaves the old release's
 * schema and data exactly as they were.
 */
export async function preflightReviewBaseConversion(
  sql: postgres.Sql,
  context: DataStepContext,
): Promise<void> {
  if (!context.hasApplied(SETTLEMENT_BATCHES_MIGRATION)) return;
  const [{ present }] = await sql<{ present: boolean }[]>`
    SELECT to_regclass('branch_push_settlement_batches') IS NOT NULL AS present`;
  if (!present) {
    throw new Error(
      `${REVIEW_BASE_CONVERSION_STEP_ID}: database ${context.databaseName} records ${SETTLEMENT_BATCHES_MIGRATION} as applied but has no branch_push_settlement_batches table`,
    );
  }
  const batches = await sql<{ id: string; state: string; last_error_code: string | null }[]>`
    SELECT id, state, last_error_code FROM branch_push_settlement_batches
    WHERE state IN ('pending', 'blocked') ORDER BY created_at, id LIMIT ${MAX_REPORTED + 1}`;
  if (batches.length === 0) return;
  const lines = batches
    .slice(0, MAX_REPORTED)
    .map(
      (batch) =>
        `  - batch ${batch.id}, state ${batch.state}, last error ${batch.last_error_code ?? "none"}`,
    );
  if (batches.length > MAX_REPORTED) lines.push(`  ... and more`);
  throw new Error(
    `${REVIEW_BASE_CONVERSION_STEP_ID}: database ${context.databaseName} has unfinished settlement batches; ` +
      `this release changes their member protocol and payload, so they cannot be settled after the upgrade. ` +
      `Nothing was migrated. Start the old release and let its recovery drain pending batches, then stop it and run db:migrate again; ` +
      `a blocked batch needs a person to diagnose its error first.\n${lines.join("\n")}`,
  );
}

export async function convertReviewBases(
  sql: postgres.Sql,
  context: DataStepContext,
): Promise<ReviewBaseConversionSummary> {
  const summary: ReviewBaseConversionSummary = { scanned: 0, converted: 0 };
  const failures: string[] = [];
  let after = "";
  for (;;) {
    const rows = await sql<EligibleRow[]>`
      ${SELECT_ROW(sql)}
      WHERE ${sql.unsafe(ELIGIBLE_BRANCH_PREDICATE)} AND b.id > ${after}
      ORDER BY b.id LIMIT ${BATCH}`;
    if (rows.length === 0) break;
    for (const first of rows) {
      after = first.id;
      summary.scanned += 1;
      let row: EligibleRow | undefined = first;
      let outcome =
        "state kept changing under a concurrent writer; stop the app servers and run again";
      for (let attempt = 0; row && attempt < MAX_CAS_ATTEMPTS; attempt++) {
        let next: ReturnType<typeof convertLegacyDraft>;
        try {
          next = convertLegacyDraft({
            state: row.state,
            liveCut: row.live_cut,
            neverWritten: !row.journaled,
          });
        } catch (error) {
          outcome = `state cannot be converted (${error instanceof Error ? error.name : "unknown error"})`;
          break;
        }
        if (next.kind === "unresolved") {
          outcome =
            "no live_cut to derive a base from, and the branch has journal rows so its text may differ from its last pull";
          break;
        }
        const updated = await sql`
          UPDATE document_branches AS b SET
            state = ${Buffer.from(next.state)}, state_vector = ${Buffer.from(next.stateVector)},
            base_revision = ${sql.json(UNKNOWN_BASE_REVISION)}, has_effect = ${next.hasEffect}
          WHERE b.id = ${row.id} AND ${sql.unsafe(ELIGIBLE_BRANCH_PREDICATE)} AND b.state = ${row.state}
          RETURNING b.id`;
        if (updated.length > 0) {
          summary.converted += 1;
          outcome = "";
          break;
        }
        // Lost the CAS to a writer: re-read; another process may have converted or closed the row.
        [row] = await sql<EligibleRow[]>`
          ${SELECT_ROW(sql)} WHERE b.id = ${first.id} AND ${sql.unsafe(ELIGIBLE_BRANCH_PREDICATE)}`;
        if (!row) outcome = "";
      }
      if (outcome) failures.push(`${rowIdentity(context.databaseName, first)}: ${outcome}`);
    }
  }
  if (failures.length > 0) {
    const shown = failures.slice(0, MAX_REPORTED).map((failure) => `  - ${failure}`);
    const more =
      failures.length > MAX_REPORTED ? [`  ... and ${failures.length - MAX_REPORTED} more`] : [];
    throw new Error(
      `${REVIEW_BASE_CONVERSION_STEP_ID}: ${failures.length} draft branch(es) could not get a review base; ` +
        `the next migration would destroy their only baseline. Repair or recover each branch's baseline from backup, then run db:migrate again; the drafts are untouched.\n` +
        [...shown, ...more].join("\n"),
    );
  }
  return summary;
}
