import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import type { ThreadRepositories } from "../../../threads/index.js";
import type { ToolRegistry } from "../../tools/types.js";
import {
  type FinalizedExecution,
  finalizeExecution,
  type TerminalCause,
} from "../execution-finalizer.js";
import { finalizeOrphanedTurns } from "../orphaned-placeholder.js";
import type { PersistenceDeps } from "../persistence.js";
import type { Lease, RunClaim } from "../ports.js";
import { LostRunError } from "../runtime-delivery.js";
import type { ThreadLock } from "../thread-lock.js";
import type { DeliveryLeaseStore, DeliveryStore } from "./delivery-ports.js";

export type Deliverer = { turn: Pick<Turn, "id"> };

export type Retirement = Deliverer | { handedBackBy: string } | null;

export type ExecutionSettlementDeps = PersistenceDeps & {
  repos: ThreadRepositories;
  toolRegistry?: Pick<ToolRegistry, "getRegistration">;
  publishFinalizedReports(reports: readonly SavedExecutionReport[]): Promise<void>;
  recoverCommands: Parameters<typeof finalizeExecution>[0]["recoverCommands"];
  publishStatus?(threadId: ThreadId): Promise<void>;
  inbox: DeliveryStore;
  leaseStore: DeliveryLeaseStore;
  runClaim: Pick<RunClaim, "release" | "abandon">;
  threadLock: ThreadLock;
  schedulePostCommit(task: () => Promise<void>): void;
};

export function createExecutionSettlement(deps: ExecutionSettlementDeps) {
  const { inbox, leaseStore, threadLock } = deps;

  const deliveredBy = (turn: Pick<Turn, "id">): Deliverer => ({ turn });

  async function clearBlockWhenIdle(threadId: ThreadId) {
    const projection = await inbox.readPendingProjection(threadId);
    if (
      !projection.messages.some(
        (message) => message.intent === "message" || message.intent === "control",
      )
    )
      await inbox.setBlockedReason(threadId, null);
  }

  async function ack(threadId: ThreadId, ids: readonly string[], by: Retirement = null) {
    if (ids.length > 0)
      await inbox.ack(
        threadId,
        [...ids],
        by && "turn" in by ? (by.turn.id as TurnId) : null,
        by && "handedBackBy" in by ? { handedBackBy: by.handedBackBy } : undefined,
      );
    await clearBlockWhenIdle(threadId);
  }

  async function endExecution(lease: Lease) {
    await deps.runClaim.release(lease);
  }

  async function acknowledgeFailedReply(lease: Lease, turn: Turn, messageIds: readonly string[]) {
    if (turn.role === "assistant" && (turn.status === "cancelled" || turn.status === "error"))
      await ack(lease.threadId, messageIds, deliveredBy(turn));
  }

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

  const closeCause = (
    input: { cause: TerminalCause; localCancellation?: () => TerminalCause | null },
    receipt: { cancelRequested: boolean } | null,
  ): TerminalCause =>
    receipt?.cancelRequested
      ? { kind: "cancelled", reason: "cancelled" }
      : (input.localCancellation?.() ?? input.cause);

  const settleClosed = (input: {
    lease: Lease;
    turnId: TurnId;
    cause: TerminalCause;
    localCancellation?: () => TerminalCause | null;
  }) =>
    threadLock.withThreadLock(input.lease.threadId, async () => {
      const receipt = await leaseStore.lockReceipt(input.lease);
      return settleTerminal(input.lease, input.turnId, closeCause(input, receipt), receipt);
    });

  const storeUnderLease = <T>(lease: Lease, persist: () => Promise<T>) =>
    threadLock.withThreadLock(lease.threadId, async () => {
      if (!(await leaseStore.lockReceipt(lease))) throw new LostRunError(lease);
      return persist();
    });

  const ackWithResponse = <T>(
    lease: Lease,
    ids: readonly string[],
    byTurn: Pick<Turn, "id" | "position">,
    persist: () => Promise<T>,
  ) =>
    storeUnderLease(lease, async () => {
      const result = await persist();
      if (ids.length > 0) {
        if (!(await leaseStore.clearReceipt(lease, ids))) throw new LostRunError(lease);
        await ack(lease.threadId, [...ids], deliveredBy(byTurn));
      }
      return result;
    });

  const clearOrphanedTurn = async (threadId: ThreadId, turnId: TurnId) => {
    const receipt = await leaseStore.lockThreadReceipt(threadId);
    if (!receipt || receipt.turnId !== turnId) return null;
    if (!(await leaseStore.clearOrphanedReceipt(threadId, turnId, receipt.ids))) {
      throw new Error("Cannot clear orphaned run receipt after it changed");
    }
    return receipt.ids;
  };
  const retireOrphanedReply = async (threadId: ThreadId, turnId: TurnId) => {
    const ids = await clearOrphanedTurn(threadId, turnId);
    if (!ids) return;
    await ack(threadId, ids, deliveredBy({ id: turnId }));
  };
  const clearOrphanedReceipt = async (threadId: ThreadId, turnId: TurnId) => {
    await clearOrphanedTurn(threadId, turnId);
  };

  const repairOrphans = (threadId: ThreadId, scope: "sweep" | "claimed") =>
    finalizeOrphanedTurns(
      { ...deps, retireOrphanedReply, clearOrphanedTurn: clearOrphanedReceipt },
      { threadId, scope },
    );

  const publishIdle = (threadId: ThreadId) =>
    deps.schedulePostCommit(async () => {
      await deps.publishStatus?.(threadId);
    });

  async function settleStaleExecution<T = void>(
    threadId: ThreadId,
    repair?: () => Promise<T>,
  ): Promise<T | undefined> {
    if (repair) return settleSweepLane(threadId, repair);
    const reports = await threadLock.withThreadLock(threadId, async () => {
      const stale = await leaseStore.lockThreadReceipt(threadId);
      const finalized = await repairOrphans(threadId, stale ? "claimed" : "sweep");
      if (!stale) return finalized;
      const turns = await deps.repos.turns.listByExecution(threadId, stale.lease.executionId);
      if (turns.some((turn) => !isTerminalTurnStatus(turn.status)))
        throw new Error("A stale execution still has unsettled turns after repair");
      await endExecution(stale.lease);
      publishIdle(threadId);
      return finalized;
    });
    await deps.publishFinalizedReports(reports);
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

  async function releaseExecution(lease: Lease): Promise<"released" | "ended" | "abandoned"> {
    let outcome: "released" | "ended" | "abandoned";
    try {
      outcome = await threadLock.withThreadLock(lease.threadId, async () => {
        if (!(await leaseStore.lockReceipt(lease))) {
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
    endExecution,
    settleTerminal,
    closeCause,
    settleClosed,
    ackWithResponse,
    storeUnderLease,
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
