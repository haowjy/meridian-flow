/**
 * The execution and receipt lifecycle of the delivery adapter: acknowledgement, ending an
 * execution, abandoning its claim, settling a stale lease and retiring orphaned turns.
 * Delivery decides what a reply receives; this owns how its lease row and receipt settle.
 * Every operation that writes runs under the chat's thread lock, which the caller holds
 * unless the method says it takes the lock itself.
 */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import {
  type FinalizedExecution,
  finalizeExecution,
  type TerminalCause,
} from "../loop/execution-finalizer.js";
import { finalizeOrphanedTurns } from "../loop/orphaned-placeholder.js";
import type { PersistenceDeps } from "../loop/persistence.js";
import type { Lease, RunClaim } from "../loop/ports.js";
import type { ThreadLock } from "../loop/thread-lock.js";
import type { DeliveryLeaseStore, DeliveryStore } from "./delivery-ports.js";

/** The turn current when an execution acknowledges messages, and its execution. */
export type Deliverer = {
  turn: { id: string; position: number | null };
  executionId: string | null;
};

export type ExecutionSettlementDeps = PersistenceDeps & {
  repos: import("../../threads/index.js").ThreadRepositories;
  toolRegistry?: Pick<import("../tools/types.js").ToolRegistry, "getRegistration">;
  publishFinalizedReports(reports: readonly SavedExecutionReport[]): Promise<void>;
  publishStatus?(threadId: ThreadId): Promise<void>;
  inbox: DeliveryStore;
  leaseStore: DeliveryLeaseStore;
  runClaim: Pick<RunClaim, "release" | "abandon">;
  threadLock: ThreadLock;
  schedulePostCommit(task: () => Promise<void>): void;
};

export function createExecutionSettlement(deps: ExecutionSettlementDeps) {
  const { inbox, leaseStore, threadLock } = deps;

  const deliveredBy = (lease: Lease, turn: Pick<Turn, "id" | "position">): Deliverer => ({
    turn,
    executionId: lease.executionId,
  });

  /** A usage block clears the moment no message or control waits behind it. */
  async function clearBlockWhenIdle(threadId: ThreadId) {
    const projection = await inbox.readPendingProjection(threadId);
    if (
      !projection.messages.some(
        (message) => message.intent === "message" || message.intent === "control",
      )
    )
      await inbox.setBlockedReason(threadId, null);
  }

  /**
   * The one acknowledgement path. Message rows this call actually delivers record their
   * deliverer; controls and notices record nothing. The inbox write marks the chat, so the
   * transaction publishes the record. Every retirement path goes through here under the
   * caller's thread lock, so a usage block is cleared the moment no message or control waits
   * behind it.
   */
  async function ack(threadId: ThreadId, ids: readonly string[], by: Deliverer | null = null) {
    if (ids.length > 0) await inbox.ack(threadId, [...ids], (by?.turn.id as TurnId) ?? null);
    await clearBlockWhenIdle(threadId);
  }

  /**
   * Ends an execution in the transaction that wrote its last terminal turn: deletes the lease
   * row, whose release marks the chat so that transaction publishes the closed record. This is
   * the one end operation, for a run's own close and for a stale lease alike.
   */
  async function endExecution(lease: Lease) {
    await deps.runClaim.release(lease);
  }

  /** A failed or cancelled assistant delivers its messages: they are never taken on again. */
  async function acknowledgeFailedReply(lease: Lease, turn: Turn, messageIds: readonly string[]) {
    if (turn.role === "assistant" && (turn.status === "cancelled" || turn.status === "error"))
      await ack(lease.threadId, messageIds, deliveredBy(lease, turn));
  }

  /**
   * A run's terminal write: the turn finalizes, a failed reply acknowledges what it held, and
   * the execution ends. Call under the thread lock with the receipt read under it.
   */
  async function settleTerminal(
    lease: Lease,
    turnId: TurnId,
    cause: TerminalCause,
    receipt: { ids: string[] } | null,
  ): Promise<FinalizedExecution> {
    const completion = await finalizeExecution(deps, { threadId: lease.threadId, turnId, cause });
    await acknowledgeFailedReply(lease, completion.turn, receipt?.ids ?? []);
    await endExecution(lease);
    return completion;
  }

  const clearOrphanedTurn = async (threadId: ThreadId, turnId: TurnId) => {
    const receipt = await leaseStore.lockThreadReceipt(threadId);
    if (!receipt || receipt.turnId !== turnId) return null;
    if (!(await leaseStore.clearOrphanedReceipt(threadId, turnId, receipt.ids))) {
      throw new Error("Cannot clear orphaned run receipt after it changed");
    }
    return receipt.ids;
  };
  /** A dead reply's receipt retires with its messages answered. */
  const retireOrphanedReply = async (threadId: ThreadId, turnId: TurnId) => {
    const ids = await clearOrphanedTurn(threadId, turnId);
    if (!ids) return;
    const orphan = await deps.repos.turns.findById(turnId);
    await ack(threadId, ids, {
      turn: { id: turnId, position: orphan?.position ?? null },
      executionId: orphan?.executionId ?? null,
    });
  };
  /** A dead compaction's or seed's receipt clears and leaves its unanswered messages pending. */
  const clearOrphanedReceipt = async (threadId: ThreadId, turnId: TurnId) => {
    await clearOrphanedTurn(threadId, turnId);
  };

  /** The one orphan repair; call under the thread lock and the session claim. */
  const repairOrphans = (threadId: ThreadId, scope: "sweep" | "claimed") =>
    finalizeOrphanedTurns(
      { ...deps, retireOrphanedReply, clearOrphanedTurn: clearOrphanedReceipt },
      { threadId, scope },
    );

  const publishIdle = (threadId: ThreadId) =>
    deps.schedulePostCommit(async () => {
      await deps.publishStatus?.(threadId);
    });

  /**
   * Call holding the session claim. With no `repair`, this is the run starter's full
   * settlement: the claim proves a stale lease's holder is gone, so every unsettled turn is
   * repaired (reports publish, and the repairs may commit separately: a crash between them
   * loses nothing, because the end is decided from turns that carry the execution's id, never
   * from the row's receipt arrays). Then the lease ends in one transaction with the check that
   * no turn of its execution is left unsettled.
   *
   * A sweep lane passes its own `repair` and settles only what it names: a stale candidate
   * may not repair a newer receipt's execution, so the lease ends only when the repair
   * retired its receipt or the receipt was already empty.
   */
  async function settleStaleExecution<T = void>(
    threadId: ThreadId,
    repair?: () => Promise<T>,
  ): Promise<T | undefined> {
    if (repair) return settleSweepLane(threadId, repair);
    const reports = await threadLock.withThreadLock(threadId, async () =>
      repairOrphans(threadId, (await leaseStore.lockThreadReceipt(threadId)) ? "claimed" : "sweep"),
    );
    await deps.publishFinalizedReports(reports);
    await threadLock.withThreadLock(threadId, async () => {
      const stale = await leaseStore.lockThreadReceipt(threadId);
      if (!stale) return;
      const turns = await deps.repos.turns.listByExecution(threadId, stale.lease.executionId);
      if (turns.some((turn) => !isTerminalTurnStatus(turn.status)))
        throw new Error("A stale execution still has unsettled turns after repair");
      await endExecution(stale.lease);
      // The row's deletion is what turns the chat idle for readers.
      publishIdle(threadId);
    });
    return undefined;
  }

  async function settleSweepLane<T>(threadId: ThreadId, repair: () => Promise<T>): Promise<T> {
    return threadLock.withThreadLock(threadId, async () => {
      const receipt = await leaseStore.lockThreadReceipt(threadId);
      const result = await repair();
      const repaired = await leaseStore.lockThreadReceipt(threadId);
      if (
        receipt &&
        repaired?.lease.executionId === receipt.lease.executionId &&
        repaired.lease.holderId === receipt.lease.holderId &&
        repaired.turnId === null &&
        repaired.ids.length === 0
      )
        await endExecution(receipt.lease);
      publishIdle(threadId);
      return result;
    });
  }

  /**
   * A run's final release: ends the execution when every turn of it is terminal, and abandons
   * the claim (keeping the lease row as recovery evidence) when one is not.
   */
  async function releaseExecution(lease: Lease): Promise<"released" | "ended" | "abandoned"> {
    let outcome: "released" | "ended" | "abandoned";
    try {
      outcome = await threadLock.withThreadLock(lease.threadId, async () => {
        if (!(await leaseStore.lockReceipt(lease))) {
          // A close already ended it; only the physical claim may remain.
          await deps.runClaim.release(lease);
          return "released" as const;
        }
        const turns = await deps.repos.turns.listByExecution(lease.threadId, lease.executionId);
        if (turns.some((turn) => !isTerminalTurnStatus(turn.status))) return "abandoned" as const;
        await endExecution(lease);
        return "ended" as const;
      });
    } catch (error) {
      await deps.runClaim.abandon(lease);
      throw error;
    }
    if (outcome === "abandoned") await deps.runClaim.abandon(lease);
    return outcome;
  }

  /** Marks the chat blocked on credits when messages wait behind a run that cannot continue. */
  const blockForUsage = (lease: Lease) =>
    threadLock.withThreadLock(lease.threadId, async () => {
      const receipt = await leaseStore.lockReceipt(lease);
      const projection = await inbox.readPendingProjection(lease.threadId);
      if (
        !receipt ||
        !projection.messages.some(
          (message) => message.intent === "message" || message.intent === "control",
        ) ||
        projection.run?.turnId ||
        projection.blocked?.reason === "credits_exhausted"
      )
        return;
      await inbox.setBlockedReason(lease.threadId, "credits_exhausted");
    });

  return {
    deliveredBy,
    ack,
    clearBlockWhenIdle,
    endExecution,
    settleTerminal,
    settleStaleExecution,
    releaseExecution,
    blockForUsage,
    retireOrphanedReply: (threadId: ThreadId, turnId: TurnId) =>
      threadLock.withThreadLock(threadId, () => retireOrphanedReply(threadId, turnId)),
    clearOrphanedTurn: (threadId: ThreadId, turnId: TurnId) =>
      threadLock.withThreadLock(threadId, () => clearOrphanedReceipt(threadId, turnId)),
  };
}

export type ExecutionSettlement = ReturnType<typeof createExecutionSettlement>;
