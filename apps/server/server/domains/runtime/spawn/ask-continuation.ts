/**
 * Where a resolved ask's continuation stands. Its one obligation is the ask's
 * `ask_resolved` row: pending while it is outstanding, acknowledged when the
 * continuation is admitted (or a forwarded ask's relay is written), or dropped
 * by a cancellation. A row that is gone with no continuation report means the
 * obligation was cancelled before anything ran it.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import type { ExecutionReportRepository } from "../../threads/index.js";
import { isAskResolved } from "../loop/next-inbox-work.js";
import type { InboxReader } from "../loop/ports.js";

export type AskContinuation =
  | { kind: "outstanding" }
  | { kind: "admitted"; report: SavedExecutionReport }
  | { kind: "cancelled" };

/** For an ask that has resolved; an open ask has no obligation yet and reads `cancelled`. */
export async function readAskContinuation(
  deps: {
    delivery: Pick<InboxReader, "selectPending">;
    executionReports: Pick<ExecutionReportRepository, "findByContinuationAsk">;
  },
  childThreadId: ThreadId,
  askId: string,
): Promise<AskContinuation> {
  // The row first: admission acknowledges it in the commit that admits the report,
  // so a row seen gone means any admitted report is already visible.
  const pending = await deps.delivery.selectPending(childThreadId);
  if (pending.some((row) => isAskResolved(row) && row.body.askId === askId))
    return { kind: "outstanding" };
  const report = await deps.executionReports.findByContinuationAsk(askId);
  return report ? { kind: "admitted", report } : { kind: "cancelled" };
}
