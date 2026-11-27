import type { ThreadId } from "@meridian/contracts/runtime";
import type {
  HandBackRequest,
  HandBackResponse,
  SendNowRequest,
  SendNowResponse,
  StopRequest,
  StopResponse,
} from "@meridian/contracts/threads";
import { HandBackConflictError } from "../runtime-delivery.js";
import {
  decideHandBack,
  decideSendNow,
  decideStop,
  type HandBackScopeFacts,
  handBackFingerprint,
  type StopDecision,
  type StopFacts,
} from "../stop-rule.js";
import type { ThreadLock } from "../thread-lock.js";
import type {
  DeliveryLeaseStore,
  DeliveryStore,
  HandBackStore,
  StoredHandBack,
} from "./delivery-ports.js";
import type { ExecutionSettlement } from "./execution-settlement.js";

export type ThreadCommandPorts = {
  threadLock: ThreadLock;
  handBacks?: HandBackStore;
  inbox: Pick<DeliveryStore, "answerRunState">;
  ack: ExecutionSettlement["ack"];
  leaseStore: Pick<DeliveryLeaseStore, "lockThreadReceipt" | "setAdoptedMessageIds">;
  appendEvent(
    threadId: ThreadId,
    event: { type: "messages.handed_back"; userTurnIds: string[]; requestId: string },
  ): Promise<unknown>;
};

export function createThreadCommands(ports: ThreadCommandPorts) {
  const { threadLock, inbox, leaseStore } = ports;
  const requireHandBacks = () => {
    if (!ports.handBacks) throw new Error("Hand-back is not configured for this delivery adapter");
    return ports.handBacks;
  };
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
        await ports.ack(threadId, decision.handBack, { handedBackBy: input.requestId });
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
    async sendNow(threadId: ThreadId, request: SendNowRequest): Promise<SendNowResponse> {
      return threadLock.withThreadLock(threadId, async () => {
        const store = requireHandBacks();
        const facts = await store.readFacts(threadId, {
          kind: "seen",
          seenThrough: request.seenThrough,
          mine: request.waiting,
        });
        const { cancelExecutionId } = decideSendNow(facts, request);
        if (cancelExecutionId) await store.cancelExecution(threadId, cancelExecutionId);
        return {
          threadId,
          cancelledExecutionId: cancelExecutionId,
          runState: await inbox.answerRunState(threadId),
        };
      });
    },
  };
}
