import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  AskRepository,
  ExecutionReportRepository,
  ThreadRepository,
} from "../../threads/index.js";
import type { AskService } from "../asks/ask-service.js";
import type { RuntimeDelivery } from "../loop/delivery/runtime-delivery.js";
import { isAskResolved } from "../loop/next-inbox-work.js";
import type { InboxMessage, RunClaim } from "../loop/ports.js";
import type {
  LineageCancellation,
  LineageCancelled,
  LineageDecision,
} from "../loop/run-session.js";
import { asMultiThreadLocker } from "../loop/thread-lock.js";

export function createLineageCancellation(deps: {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  threads: Pick<ThreadRepository, "listSubtreeIds" | "cancelRunningSpawns">;
  runClaim: Pick<RunClaim, "requestCancel" | "fenceWakes">;
  delivery: Pick<RuntimeDelivery, "withThreadLock" | "selectPending">;
  asks: Pick<AskService, "recordCancelled">;
  askRows: Pick<AskRepository, "claimLineage">;
  reports: Pick<ExecutionReportRepository, "withdrawNotices">;
  refreshActivity(threadId: ThreadId): void;
  afterCommit(task: () => void): void;
}): LineageCancellation {
  function cancel<T>(
    threadId: ThreadId,
    decide: () => Promise<LineageDecision<T>>,
  ): Promise<LineageCancelled<T>> {
    return deps.transaction(() =>
      asMultiThreadLocker(async () => {
        const locked: ThreadId[] = [];
        return deps.delivery.withThreadLock(threadId, async () => {
          locked.push(threadId);
          const decision = await decide();
          const { reach, execution } = decision;
          const done = (targets: ThreadId[]) => ({ result: decision.result, execution, targets });
          if (!reach) return done([]);
          const targets =
            reach.kind === "thread"
              ? []
              : await deps.threads.listSubtreeIds(
                  threadId,
                  reach.kind === "turn" ? reach.turnId : undefined,
                );
          for (let index = 0; index < targets.length; index += 1) {
            const target = targets[index] as ThreadId;
            await deps.delivery.withThreadLock(target, async () => {});
            locked.push(target);
            for (const id of await deps.threads.listSubtreeIds(target))
              if (!targets.includes(id)) targets.push(id);
          }
          if (reach.kind === "terminal" && targets.length === 0) return done([]);

          const claimed = await deps.askRows.claimLineage({
            threadIds: targets,
            owner:
              reach.kind === "terminal"
                ? null
                : { threadId, turnId: reach.kind === "turn" ? reach.turnId : null, execution },
          });
          const claimedIds = new Set(claimed.map(({ ask }) => ask.id));
          const targetSet = new Set<string>(targets);
          const ownerFenced = reach.kind === "deleted" || decision.fenceOwner === true;
          const fenced = new Set<string>(ownerFenced ? [threadId, ...targets] : targets);
          const drops = (id: ThreadId, row: InboxMessage) =>
            (targetSet.has(id) && row.provenance.kind !== "writer") ||
            (fenced.has(id) &&
              (row.provenance.kind === "agent" ||
                (reach.kind === "deleted" && row.provenance.kind === "child"))) ||
            (row.provenance.kind === "child" && targetSet.has(row.provenance.threadId)) ||
            (isAskResolved(row) && claimedIds.has(row.body.askId));
          for (const id of locked)
            await deps.delivery.withThreadLock(id, async (scope) => {
              const pending = await deps.delivery.selectPending(id);
              const dropped = pending.filter((row) => drops(id, row));
              if (dropped.length > 0) await scope.acknowledge(dropped.map((row) => row.id));
              for (const claim of claimed)
                if (claim.ask.threadId === id) await deps.asks.recordCancelled(claim);
            });
          await deps.runClaim.requestCancel(
            reach.kind === "deleted" ? [threadId, ...targets] : targets,
          );
          await deps.runClaim.fenceWakes([...fenced] as ThreadId[]);
          await deps.reports.withdrawNotices(targets);
          await deps.threads.cancelRunningSpawns(targets);
          deps.afterCommit(() => {
            for (const id of [threadId, ...targets]) deps.refreshActivity(id);
          });
          return done(targets);
        });
      }),
    );
  }

  return {
    cancel,
    async endSubtree(threadId) {
      const subtree = await deps.threads.listSubtreeIds(threadId);
      if (subtree.length === 0) return [];
      const ended = await cancel(threadId, async () => ({
        result: undefined,
        reach: { kind: "terminal" },
        execution: null,
      }));
      return ended.targets;
    },
  };
}
