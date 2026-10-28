/**
 * Lineage cancellation as one durable command. In one transaction it locks every ask row it may
 * claim, then the thread locks parents first, and claims the lineage's asks (open questions, owed
 * continuations, and the live copies forwarded from them become `cancelled`). It then drops the
 * lineage's queued work, flags the live runs, stamps the machine-wake fence on every thread it
 * stopped, fences their parent notices and settles parked invocation cards. The fence is what
 * keeps a stopped thread stopped: a message, relay or spawn admission from an execution admitted
 * before it is refused (`RunClaim.wakeRefusal`), so local aborts after commit only make runs stop
 * sooner.
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
import type { ReportPublisher } from "./report-publisher.js";

export function createLineageCancellation(deps: {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  threads: Pick<ThreadRepository, "listSubtreeIds" | "listAncestorIds">;
  runClaim: Pick<RunClaim, "requestCancel" | "readOpenExecutionId" | "fenceWakes">;
  delivery: Pick<RuntimeDelivery, "withThreadLock" | "selectPending">;
  asks: Pick<AskService, "recordCancelled">;
  askRows: Pick<AskRepository, "lockHeldByThreads" | "listCopyHolders" | "claimLineage">;
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
    return deps.transaction(() =>
      asMultiThreadLocker(async () => {
        const subtree = known ?? (await deps.threads.listSubtreeIds(threadId));
        const ancestors = await deps.threads.listAncestorIds(threadId);
        // Every ask row this command can claim, in one id-ordered statement before any thread
        // lock: the lineage's own, and its ancestors', where forwarded copies of its questions live.
        const preLocked = new Set<ThreadId>([...ancestors, threadId, ...subtree]);
        await deps.askRows.lockHeldByThreads([...preLocked]);
        // The ancestors it writes to: the owner's parent (a parked owner's card), each thread
        // holding a live copy of a lineage question, and that thread's parent (its card).
        const holders = new Set(await deps.askRows.listCopyHolders([threadId, ...subtree]));
        let reach = 1;
        ancestors.forEach((id, index) => {
          if (holders.has(id)) reach = index + 2;
        });
        const lockedAncestors = ancestors.slice(0, reach);
        // Held to commit (Postgres) and reentrant, so the per-thread pass below locks again.
        const locked: ThreadId[] = [];
        const lock = async (id: ThreadId) => {
          // A child spawned after the listing: the one ask lock taken after a thread lock.
          // It can only hold an ask if it ran a whole model turn in this window.
          if (!preLocked.has(id)) await deps.askRows.lockHeldByThreads([id]);
          await deps.delivery.withThreadLock(id, async () => {});
          locked.push(id);
        };
        for (const id of [...lockedAncestors].reverse()) await lock(id);
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
            await lock(target);
            for (const id of await deps.threads.listSubtreeIds(target))
              if (!targets.includes(id)) targets.push(id);
          }
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
          // A target loses all its queued machine work; writer sends stay, as the writer's own
          // request to that chat. Elsewhere only what names the lineage goes: a target's
          // notices, and hints and question notices for asks this command claimed.
          const drops = (id: ThreadId, row: InboxMessage) =>
            targetSet.has(id)
              ? row.provenance.kind !== "writer"
              : row.provenance.kind === "child"
                ? targetSet.has(row.provenance.threadId) ||
                  ("ask" in row.provenance && claimedIds.has(row.provenance.ask.id))
                : isAskResolved(row) && claimedIds.has(row.body.askId);
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
          // The owner stops too when the writer stopped or deleted the chat; a cancelled turn
          // or a finished run leaves the owner free to be woken.
          await deps.runClaim.fenceWakes(
            reach.kind === "chat" || reach.kind === "deleted" ? [threadId, ...targets] : targets,
          );
          await deps.reports.withdrawNotices(targets);
          for (const parked of new Set(claimed.map(({ ask }) => ask.threadId)))
            await deps.publisher.settleCancelledAsk(parked);
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
