/**
 * The durable half of lineage cancellation. A parked child lives only in the
 * database, so the lineage is read from thread rows, not from live sessions; the
 * run session (`loop/run-session.ts`) adds the local aborts and waits between
 * these steps.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { AskRepository, ThreadRepository } from "../../threads/index.js";
import type { AskService } from "../asks/ask-service.js";
import { isAskResolved } from "../loop/next-inbox-work.js";
import type { InboxMessage, RunClaim } from "../loop/ports.js";
import type { LineageCancellation } from "../loop/run-session.js";
import type { RuntimeDelivery } from "../loop/runtime-delivery.js";
import type { ReportPublisher } from "./report-publisher.js";

export function createLineageCancellation(deps: {
  threads: Pick<ThreadRepository, "listSubtreeIds">;
  runClaim: Pick<RunClaim, "requestCancel" | "readOpenExecutionId">;
  delivery: Pick<RuntimeDelivery, "withThreadLock" | "selectPending">;
  asks: Pick<AskService, "cancelForThreadLifecycle" | "cancelOpen">;
  openAsks: Pick<AskRepository, "findOpenByThread">;
  publisher: Pick<ReportPublisher, "settleCancelledAsk">;
  /** Refreshes the parent's subagent activity for a child whose state changed. */
  refreshActivity(threadId: ThreadId): void;
}): LineageCancellation {
  return {
    targets(scope) {
      return deps.threads.listSubtreeIds(
        scope.threadId,
        scope.kind === "turn" ? scope.turnId : undefined,
      );
    },
    async withdraw(scope, threadIds) {
      const drop = (
        threadId: ThreadId,
        select: (pending: InboxMessage[]) => Promise<InboxMessage[]>,
      ) =>
        deps.delivery.withThreadLock(threadId, async (producer) => {
          const dropped = await select(await deps.delivery.selectPending(threadId));
          if (dropped.length > 0) await producer.acknowledge(dropped.map((row) => row.id));
        });
      await deps.runClaim.requestCancel(threadIds);
      // Writer sends stay: they are the writer's own request to that chat.
      for (const threadId of threadIds)
        await drop(threadId, async (pending) =>
          pending.filter((row) => row.provenance.kind !== "writer"),
        );
      // A terminal child's own rows are not its lineage's to cancel.
      if (scope.kind === "terminal" && threadIds.length === 0) return;
      const targets = new Set<string>(threadIds);
      await drop(scope.threadId, async (pending) => {
        // Stop and a cancelled turn end the owner's continuation obligations (a relay in
        // flight, an answer not yet continued) with the execution holding them, or with
        // none; an execution the command spared keeps its own. Only an execution that
        // reserved a turn has adopted a row, and a later adoption re-reads under this lock.
        const continuations =
          scope.kind !== "terminal" &&
          pending.some(isAskResolved) &&
          [null, scope.execution].includes(await deps.runClaim.readOpenExecutionId(scope.threadId));
        return pending.filter((row) =>
          row.provenance.kind === "child"
            ? targets.has(row.provenance.threadId)
            : continuations && isAskResolved(row),
        );
      });
    },
    async settle(scope, threadIds) {
      // An open ask holds its thread's queue, so asks are cancelled only once the lineage's
      // queued work is gone, and a cancelled turn's own question after its subtrees'.
      if (scope.kind === "turn") {
        for (const root of threadIds) await deps.asks.cancelForThreadLifecycle(root);
        const ask = await deps.openAsks.findOpenByThread(scope.threadId);
        if (ask?.askingTurnId === scope.turnId) await deps.asks.cancelOpen(scope.threadId, ask.id);
      } else await deps.asks.cancelForThreadLifecycle(scope.threadId);
      for (const threadId of [scope.threadId, ...threadIds]) {
        await deps.publisher.settleCancelledAsk(threadId);
        deps.refreshActivity(threadId);
      }
    },
  };
}
