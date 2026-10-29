/**
 * Lineage cancellation as one durable command. In one transaction it takes the owner's thread
 * lock, lets the trigger decide, then takes each target's lock parents first and claims the
 * lineage's asks (open questions and owed continuations become `cancelled`). It then drops the
 * stopped threads' queued machine work, flags the live runs, stamps the machine-wake fence on every
 * thread it stopped, withdraws the targets' parent notices and settles their spawn status. The
 * fence is what keeps a stopped thread stopped: a message or spawn admission from an execution
 * admitted before it is refused at enqueue (`RunClaim.wakeRefusal`), so local aborts after commit
 * only make runs stop sooner.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  AskRepository,
  ExecutionReportRepository,
  ThreadRepository,
} from "../../threads/index.js";
import type { AskService } from "../asks/ask-service.js";
import { isAskResolved } from "../loop/next-inbox-work.js";
import type { InboxMessage, RunClaim } from "../loop/ports.js";
import type {
  LineageCancellation,
  LineageCancelled,
  LineageDecision,
} from "../loop/run-session.js";
import type { RuntimeDelivery } from "../loop/runtime-delivery.js";
import { asMultiThreadLocker } from "../loop/thread-lock.js";

export function createLineageCancellation(deps: {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  threads: Pick<ThreadRepository, "listSubtreeIds" | "cancelRunningSpawns">;
  runClaim: Pick<RunClaim, "requestCancel" | "fenceWakes">;
  delivery: Pick<RuntimeDelivery, "withThreadLock" | "selectPending">;
  asks: Pick<AskService, "recordCancelled">;
  askRows: Pick<AskRepository, "claimLineage">;
  reports: Pick<ExecutionReportRepository, "withdrawNotices">;
  /** Refreshes the parent's subagent activity for a child whose state changed. */
  refreshActivity(threadId: ThreadId): void;
  afterCommit(task: () => void): void;
}): LineageCancellation {
  function cancel<T>(
    threadId: ThreadId,
    decide: () => Promise<LineageDecision<T>>,
    known?: ThreadId[],
  ): Promise<LineageCancelled<T>> {
    return deps.transaction(() =>
      asMultiThreadLocker(async () => {
        const subtree = known ?? (await deps.threads.listSubtreeIds(threadId));
        // Held to commit (Postgres) and reentrant, so the per-thread pass below locks again.
        const locked: ThreadId[] = [];
        return deps.delivery.withThreadLock(threadId, async () => {
          locked.push(threadId);
          const decision = await decide();
          const { reach, execution } = decision;
          const done = (targets: ThreadId[]) => ({ result: decision.result, execution, targets });
          if (!reach) return done([]);
          // Parents first. Under each thread's lock its subtree is listed again: a spawn that
          // committed before that lock is a target too, and a later one waits for this commit,
          // then finds its sender cancelled.
          const targets =
            reach.kind === "turn" ? await deps.threads.listSubtreeIds(threadId, reach.turnId) : [];
          if (reach.kind !== "turn")
            for (const id of [...subtree, ...(await deps.threads.listSubtreeIds(threadId))])
              if (!targets.includes(id)) targets.push(id);
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
                : { threadId, turnId: reach.kind === "turn" ? reach.turnId : null },
          });
          const claimedIds = new Set(claimed.map(({ ask }) => ask.id));
          const targetSet = new Set<string>(targets);
          // The owner stops too when the writer stopped or deleted the chat; a cancelled turn
          // or a finished run leaves the owner free to be woken.
          const fenced = new Set<string>(
            reach.kind === "chat" || reach.kind === "deleted" ? [threadId, ...targets] : targets,
          );
          // A target loses all its queued machine work; writer sends stay, as the writer's own
          // request to that chat. A stopped owner loses the machine messages that would wake it
          // (Work notices never start a run, so they stay). Elsewhere only what names the
          // lineage goes: a target's report notices, and hints for asks this command claimed.
          const drops = (id: ThreadId, row: InboxMessage) =>
            (targetSet.has(id) && row.provenance.kind !== "writer") ||
            (fenced.has(id) &&
              (row.provenance.kind === "agent" || row.provenance.kind === "child")) ||
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
      const ended = await cancel(
        threadId,
        async () => ({ result: undefined, reach: { kind: "terminal" }, execution: null }),
        subtree,
      );
      return ended.targets;
    },
  };
}
