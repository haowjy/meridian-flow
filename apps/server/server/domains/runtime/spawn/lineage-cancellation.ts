/**
 * The durable half of lineage cancellation. A parked child lives only in the
 * database, so the lineage is read from thread rows, not from live sessions; the
 * run session (`loop/run-session.ts`) adds the local aborts and waits between
 * these steps.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ThreadRepository } from "../../threads/index.js";
import type { AskService } from "../asks/ask-service.js";
import type { RunClaim } from "../loop/ports.js";
import type { LineageCancellation, LineageScope } from "../loop/run-session.js";
import type { RuntimeDelivery } from "../loop/runtime-delivery.js";
import type { ReportPublisher } from "./report-publisher.js";

export function createLineageCancellation(deps: {
  threads: Pick<ThreadRepository, "listSubtreeIds">;
  runClaim: Pick<RunClaim, "requestCancel">;
  delivery: Pick<RuntimeDelivery, "withThreadLock" | "selectPending">;
  asks: Pick<AskService, "cancelForThreadLifecycle">;
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
    requestCancel: (threadIds) => deps.runClaim.requestCancel(threadIds),
    async dropPending(owner, threadIds) {
      const targets = new Set<string>(threadIds);
      for (const threadId of [...threadIds, owner]) {
        await deps.delivery.withThreadLock(threadId, async (producer) => {
          // Writer sends stay: they are the writer's own request to that chat.
          const dropped = (await deps.delivery.selectPending(threadId)).filter((row) =>
            threadId === owner
              ? row.provenance.kind === "child" && targets.has(row.provenance.threadId)
              : row.provenance.kind !== "writer",
          );
          if (dropped.length > 0) await producer.acknowledge(dropped.map((row) => row.id));
        });
      }
    },
    async settle(scope: LineageScope, threadIds) {
      // A turn owns only the subtrees it spawned; a chat or a terminal child owns all of its own.
      for (const root of scope.kind === "turn" ? threadIds : [scope.threadId])
        await deps.asks.cancelForThreadLifecycle(root);
      for (const threadId of [scope.threadId, ...threadIds]) {
        await deps.publisher.settleCancelledAsk(threadId);
        deps.refreshActivity(threadId);
      }
    },
  };
}
