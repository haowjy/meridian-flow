/**
 * Lineage cancellation as one durable command. In one transaction it takes the owner's thread
 * lock, lets the trigger decide, then takes each target's lock parents first and claims the
 * lineage's asks (open questions, the cancelled execution's pending one and owed continuations
 * become `cancelled`). It then drops the stopped threads' queued machine work, flags the live
 * runs, stamps the machine-wake fence on every thread it stopped, withdraws the targets' parent notices and settles their spawn status. The
 * fence is what keeps a stopped thread stopped: a message or spawn admission from an execution
 * admitted before it is refused at enqueue (`RunClaim.wakeRefusal`), so local aborts after commit
 * only make runs stop sooner. A `thread` reach (Stop, Send now) ends only the owner's reply: no
 * descendant is a target. Whether the owner is fenced is the decision's `fenceOwner`, not the reach.
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
  ): Promise<LineageCancelled<T>> {
    return deps.transaction(() =>
      asMultiThreadLocker(async () => {
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
          // `thread` (Stop, Send now) reaches no descendant: the owner's reply is all it ends.
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
          // The owner is fenced when the writer deleted the chat, or when the decision asks for it
          // (Stop on a subagent). The fence refuses a wake from ANY sender admitted before the Stop,
          // not only ancestors: a surviving child's mid-run `thread_message` is refused too, while a
          // child's report lands, since a report row carries no sender. A stopped primary chat is
          // not fenced, so reports wake it. Send now never fences: it runs the queue next.
          const ownerFenced = reach.kind === "deleted" || decision.fenceOwner === true;
          const fenced = new Set<string>(ownerFenced ? [threadId, ...targets] : targets);
          // A target loses all its queued machine work; writer sends stay, as the writer's own
          // request to that chat. A fenced owner loses the `agent` messages from above that would
          // wake it, and a deleted one its `child` reports too: a finished child's report is
          // work Stop keeps (Work notices never start a run, so they stay). Elsewhere only what
          // names the lineage goes: a target's report notices, and hints for asks this command claimed.
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
