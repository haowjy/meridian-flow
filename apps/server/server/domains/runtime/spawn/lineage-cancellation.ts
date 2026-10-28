/**
 * Lineage cancellation as one durable command. In one transaction it claims the
 * lineage's asks (open questions and owed continuations become `cancelled`), then
 * under the thread locks, parents first, drops the lineage's queued work, flags
 * the live runs, fences their parent notices and settles parked invocation cards.
 * Nothing it removes can wake anything it hasn't, because it all commits at once;
 * the run session's local aborts after commit only make runs stop sooner.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  AskRepository,
  ExecutionReportRepository,
  ThreadRepository,
} from "../../threads/index.js";
import type { AskService } from "../asks/ask-service.js";
import { isAskResolved } from "../loop/next-inbox-work.js";
import type { RunClaim } from "../loop/ports.js";
import type {
  LineageCancellation,
  LineageCancelled,
  LineageDecision,
} from "../loop/run-session.js";
import type { RuntimeDelivery } from "../loop/runtime-delivery.js";
import type { ReportPublisher } from "./report-publisher.js";

export function createLineageCancellation(deps: {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  threads: Pick<ThreadRepository, "findById" | "listSubtreeIds">;
  runClaim: Pick<RunClaim, "requestCancel" | "readOpenExecutionId">;
  delivery: Pick<RuntimeDelivery, "withThreadLock" | "selectPending">;
  asks: Pick<AskService, "recordCancelled">;
  askRows: Pick<AskRepository, "lockHeldByThreads" | "claimLineage">;
  reports: Pick<ExecutionReportRepository, "withdrawNotices">;
  publisher: Pick<ReportPublisher, "settleCancelledAsk">;
  /** Refreshes the parent's subagent activity for a child whose state changed. */
  refreshActivity(threadId: ThreadId): void;
  afterCommit(task: () => void): void;
}): LineageCancellation {
  function cancel<T>(
    threadId: ThreadId,
    decide: () => Promise<LineageDecision<T>>,
    known?: ThreadId[],
  ): Promise<LineageCancelled<T>> {
    return deps.transaction(async () => {
      const subtree = known ?? (await deps.threads.listSubtreeIds(threadId));
      // Ask rows before thread locks, as every ask transition takes them.
      await deps.askRows.lockHeldByThreads([threadId, ...subtree]);
      // A parked owner's card is in its parent, which locks first.
      const parentThreadId = (await deps.threads.findById(threadId))?.parentThreadId;
      if (parentThreadId) await deps.delivery.withThreadLock(parentThreadId, async () => {});
      return deps.delivery.withThreadLock(threadId, async (owner) => {
        const decision = await decide();
        const { reach, execution } = decision;
        const done = (targets: ThreadId[]) => ({ result: decision.result, execution, targets });
        if (!reach) return done([]);
        const targets =
          reach.kind === "turn"
            ? await deps.threads.listSubtreeIds(threadId, reach.turnId)
            : subtree;
        if (reach.kind === "terminal" && targets.length === 0) return done([]);
        const open = await deps.runClaim.readOpenExecutionId(threadId);
        const claimed = await deps.askRows.claimLineage({
          threadIds: targets,
          owner:
            reach.kind === "terminal"
              ? null
              : {
                  threadId,
                  turnId: reach.kind === "turn" ? reach.turnId : null,
                  spare: reach.kind !== "deleted" && open !== execution ? open : null,
                },
        });
        const claimedIds = new Set(claimed.map(({ ask }) => ask.id));
        const targetSet = new Set<string>(targets);
        const record = async (id: ThreadId) => {
          for (const claim of claimed)
            if (claim.ask.threadId === id) await deps.asks.recordCancelled(claim);
        };

        const ownerDrops = (await deps.delivery.selectPending(threadId)).filter((row) =>
          row.provenance.kind === "child"
            ? targetSet.has(row.provenance.threadId)
            : isAskResolved(row) && claimedIds.has(row.body.askId),
        );
        if (ownerDrops.length > 0) await owner.acknowledge(ownerDrops.map((row) => row.id));
        await record(threadId);
        for (const target of targets)
          await deps.delivery.withThreadLock(target, async (producer) => {
            // Writer sends stay: they are the writer's own request to that chat.
            const dropped = (await deps.delivery.selectPending(target)).filter(
              (row) => row.provenance.kind !== "writer",
            );
            if (dropped.length > 0) await producer.acknowledge(dropped.map((row) => row.id));
            await record(target);
          });
        await deps.runClaim.requestCancel(
          reach.kind === "deleted" ? [threadId, ...targets] : targets,
        );
        await deps.reports.withdrawNotices(targets);
        for (const parked of new Set(claimed.map(({ ask }) => ask.threadId)))
          await deps.publisher.settleCancelledAsk(parked);
        deps.afterCommit(() => {
          for (const id of [threadId, ...targets]) deps.refreshActivity(id);
        });
        return done(targets);
      });
    });
  }

  return {
    cancel,
    async endSubtree(threadId) {
      const subtree = await deps.threads.listSubtreeIds(threadId);
      if (subtree.length === 0) return [];
      const ended = await cancel(
        threadId,
        async () => ({ result: undefined, reach: { kind: "terminal" }, execution: null }),
        subtree,
      );
      return ended.targets;
    },
  };
}
