/**
 * The chat's writer commands that take messages out of the queue or cancel the open reply: hand-back
 * (the queue's x and Cancel queue), Stop and Send now. Each is decided once under the thread lock, from
 * rows read inside it, by the pure rules in `loop/stop-rule.ts`; this module reads the facts, calls the
 * rule, then applies the decision. Hand-back and Stop store the decision by request id so a replay
 * answers the same; Send now keeps no decision (`seenExecutionId` makes a repeat safe).
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  HandBackRequest,
  HandBackResponse,
  StopRequest,
  StopResponse,
} from "@meridian/contracts/threads";
import { HandBackConflictError } from "../loop/runtime-delivery.js";
import {
  decideHandBack,
  decideStop,
  type HandBackScopeFacts,
  handBackFingerprint,
  type StopDecision,
  type StopFacts,
} from "../loop/stop-rule.js";
import type { ThreadLock } from "../loop/thread-lock.js";
import type {
  DeliveryLeaseStore,
  DeliveryStore,
  HandBackStore,
  StoredHandBack,
} from "./delivery-ports.js";

export type ThreadCommandPorts = {
  threadLock: ThreadLock;
  /** Absent where hand-back is not supported (the in-memory harness). */
  handBacks?: HandBackStore;
  inbox: Pick<DeliveryStore, "ack" | "answerRunState">;
  leaseStore: Pick<DeliveryLeaseStore, "lockThreadReceipt" | "setAdoptedMessageIds">;
  appendEvent(
    threadId: ThreadId,
    event: { type: "messages.handed_back"; userTurnIds: string[]; requestId: string },
  ): Promise<unknown>;
  clearBlockWhenIdle(threadId: ThreadId): Promise<void>;
};

export function createThreadCommands(ports: ThreadCommandPorts) {
  const { threadLock, inbox, leaseStore } = ports;
  const requireHandBacks = () => {
    if (!ports.handBacks) throw new Error("Hand-back is not configured for this delivery adapter");
    return ports.handBacks;
  };
  /** A stored decision as the answer: the content comes from the immutable turns, the record is fresh. */
  async function storedHandBack(threadId: ThreadId, stored: StoredHandBack) {
    const handedBack = await requireHandBacks().contentOf(stored.handedBack);
    return {
      handedBack,
      answered: stored.answered,
      gone: stored.gone,
      cancelledExecutionId: stored.cancelledExecutionId,
      runState: await inbox.answerRunState(threadId),
    };
  }
  /**
   * One hand-back request, decided once under the thread lock from rows and stored by request id.
   * A replay with the same body returns the stored decision and flags nothing; another body is a
   * conflict. The decision is judged on the facts before any write, then applied: the stored row
   * first (the inbox rows reference it), the acknowledgements, the compaction receipt strip, the
   * journal event, and the execution's cancel flag.
   */
  function handBackRequest(
    threadId: ThreadId,
    input: {
      requestId: string;
      fingerprint: string;
      scope: HandBackScopeFacts;
      decide(facts: StopFacts): StopDecision;
    },
  ) {
    return threadLock.withThreadLock(threadId, async () => {
      const store = requireHandBacks();
      const stored = await store.find(threadId, input.requestId);
      if (stored) {
        if (stored.fingerprint !== input.fingerprint)
          throw new HandBackConflictError(input.requestId);
        return storedHandBack(threadId, stored);
      }
      const facts = await store.readFacts(threadId, input.scope);
      const decision = input.decide(facts);
      await store.record(threadId, input.requestId, input.fingerprint, {
        ...decision,
        cancelledExecutionId: decision.cancelExecutionId,
      });
      if (decision.handBack.length > 0) {
        await inbox.ack(threadId, decision.handBack, null, { handedBackBy: input.requestId });
        // A cancelled compaction gives back what it had taken on; nothing would answer it.
        const taken = decision.handBack.filter((id) => facts.receipt.includes(id));
        if (taken.length > 0) {
          const receipt = await leaseStore.lockThreadReceipt(threadId);
          if (receipt)
            await leaseStore.setAdoptedMessageIds(
              receipt.lease,
              receipt.ids.filter((id) => !taken.includes(id)),
            );
        }
        await ports.appendEvent(threadId, {
          type: "messages.handed_back",
          userTurnIds: decision.handBack,
          requestId: input.requestId,
        });
        await ports.clearBlockWhenIdle(threadId);
      }
      if (decision.cancelExecutionId)
        await store.cancelExecution(threadId, decision.cancelExecutionId);
      return storedHandBack(threadId, {
        fingerprint: input.fingerprint,
        handedBack: decision.handBack,
        answered: decision.answered,
        gone: decision.gone,
        cancelledExecutionId: decision.cancelExecutionId,
      });
    });
  }

  return {
    async handBack(threadId: ThreadId, request: HandBackRequest): Promise<HandBackResponse> {
      const scope: HandBackScopeFacts = { kind: "ids", ids: request.ids };
      const { handedBack, answered, gone, runState } = await handBackRequest(threadId, {
        requestId: request.requestId,
        fingerprint: handBackFingerprint({ kind: "hand_back", scope }),
        scope,
        // The x and Cancel queue never cancel the execution.
        decide: (facts) => ({ ...decideHandBack(facts, scope, false), cancelExecutionId: null }),
      });
      return { handedBack, answered, gone, runState };
    },
    async stop(threadId: ThreadId, request: StopRequest): Promise<StopResponse> {
      const scope: HandBackScopeFacts = {
        kind: "seen",
        seenThrough: request.seenThrough,
        mine: request.mine,
      };
      const result = await handBackRequest(threadId, {
        requestId: request.requestId,
        fingerprint: handBackFingerprint({
          kind: "stop",
          scope,
          seenExecutionId: request.seenExecutionId,
        }),
        scope,
        decide: (facts) =>
          decideStop(facts, {
            seenThrough: request.seenThrough,
            seenExecutionId: request.seenExecutionId,
            mine: request.mine,
          }),
      });
      return { threadId, ...result };
    },
  };
}
