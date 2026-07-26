/** Stateful pending-settlement store for branch-push parity tests. */

import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import type {
  PendingLiveSettlement,
  SettlementClaim,
  TrailContributionReplacement,
} from "../domain/branch-push-contracts.js";
import type { DurableTrailRecord } from "../domain/ports/change-trail-persistence.js";
import type {
  PendingSettlementStore,
  SettlementAdmission,
} from "../domain/ports/pending-settlement-store.js";

const LEASE_MS = 30_000;

type SettlementState = {
  pending: PendingLiveSettlement;
  state: "pending" | "blocked" | "completed";
  claim: SettlementClaim | null;
  claimEpoch: number;
  classifiedJoinVersion: number;
  settledJoinVersion: number | null;
  joinedSources: Set<string>;
  availableAt: Date;
  attemptCount: number;
  lastError?: string;
  lastErrorCode?: string;
  settledTrail?: DurableTrailRecord;
  replacement?: TrailContributionReplacement;
};

export type InMemoryPendingSettlementStore = PendingSettlementStore & {
  /** Mirrors the durable staging performed inside a successful push commit. */
  stage(pending: PendingLiveSettlement): void;
};

export function createInMemoryPendingSettlementStore(options?: {
  materialize?: (pending: PendingLiveSettlement) => PendingLiveSettlement;
  onCompleted?: (pushId: number) => void;
}): InMemoryPendingSettlementStore {
  const settlements = new Map<number, SettlementState>();
  const fences = new KeyedMutex();

  const store: InMemoryPendingSettlementStore = {
    stage(pending) {
      const now = new Date();
      const claim = {
        ...pending.claim,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      };
      settlements.set(pending.push.id, {
        pending: clonePending(pending, claim),
        state: "pending",
        claim,
        claimEpoch: claim.epoch,
        classifiedJoinVersion: pending.joinVersion,
        settledJoinVersion: pending.settledJoinVersion,
        joinedSources: new Set(),
        availableAt: now,
        attemptCount: pending.attemptCount,
      });
    },

    async joinAdmission(input) {
      const targetIds = [...settlements.values()]
        .filter(
          ({ pending, state }) =>
            pending.push.documentId === input.documentId &&
            state !== "completed" &&
            String(pending.push.id) !== input.excludePushId,
        )
        .map(({ pending }) => pending.push.id)
        .sort((left, right) => left - right);
      for (const pushId of targetIds) {
        await fences.run(String(pushId), async () => {
          const state = settlements.get(pushId);
          if (
            !state ||
            state.state === "completed" ||
            state.pending.push.documentId !== input.documentId ||
            String(pushId) === input.excludePushId
          ) {
            return;
          }
          const sourceKey = admissionSourceKey(input);
          if (state.joinedSources.has(sourceKey)) return;
          state.joinedSources.add(sourceKey);
          state.pending = {
            ...state.pending,
            postCutUpdates: [...state.pending.postCutUpdates, input.update],
            joinVersion: state.pending.joinVersion + 1,
            settledJoinVersion: null,
          };
          state.settledJoinVersion = null;
        });
      }
    },

    async loadLiveSettlement(pushId) {
      const state = settlements.get(pushId);
      if (state?.state !== "pending") {
        throw new Error(`Pending branch push settlement ${pushId} is unavailable`);
      }
      if (!state.claim) {
        throw new Error(`Pending branch push settlement ${pushId} is not owned`);
      }
      return snapshot(state, options?.materialize);
    },

    async claimRecoverable(input) {
      return fences.run(String(input.pushId), async () => {
        const state = settlements.get(input.pushId);
        const now = new Date();
        if (
          state?.state !== "pending" ||
          state.availableAt > now ||
          (state.claim && state.claim.leaseExpiresAt > now)
        ) {
          return null;
        }
        const claim: SettlementClaim = {
          token: input.token,
          epoch: state.claimEpoch + 1,
          kind: "recovery",
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        };
        state.claim = claim;
        state.claimEpoch = claim.epoch;
        return snapshot(state, options?.materialize);
      });
    },

    async renewClaim(input) {
      return fences.run(String(input.pushId), async () => {
        const state = settlements.get(input.pushId);
        if (!isOwned(state, input.claim)) return null;
        const claim = {
          ...input.claim,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        };
        state.claim = claim;
        return { ...claim };
      });
    },

    async handoffClaim(input) {
      return fences.run(String(input.pushId), async () => {
        const state = settlements.get(input.pushId);
        if (!isOwned(state, input.claim)) return false;
        state.claim = null;
        state.availableAt = new Date();
        return true;
      });
    },

    async recordFailure(input) {
      return fences.run(String(input.pushId), async () => {
        const state = settlements.get(input.pushId);
        if (!isOwned(state, input.claim)) return false;
        state.attemptCount += 1;
        state.lastError = input.error;
        state.claim = null;
        const backoffSeconds = Math.min(60, 2 ** Math.min(6, state.attemptCount));
        state.availableAt = new Date(Date.now() + backoffSeconds * 1_000);
        return true;
      });
    },

    async block(input) {
      return fences.run(String(input.pushId), async () => {
        const state = settlements.get(input.pushId);
        if (!isOwned(state, input.claim)) return false;
        state.state = "blocked";
        state.lastErrorCode = input.code;
        state.lastError = input.error;
        state.claim = null;
        return true;
      });
    },

    async settlePushTrail(input) {
      return fences.run(String(input.push.id), async () => {
        const state = settlements.get(input.push.id);
        if (!isOwned(state, input.claim, input.joinVersion)) return false;
        state.settledTrail = input.trail;
        state.replacement = input.replacement;
        state.classifiedJoinVersion = input.joinVersion;
        state.settledJoinVersion = input.joinVersion;
        state.pending = {
          ...state.pending,
          settledJoinVersion: input.joinVersion,
        };
        return true;
      });
    },

    async withCompletionFence(input, complete) {
      return fences.run(String(input.pushId), async () => {
        const state = settlements.get(input.pushId);
        if (
          !isOwned(state, input.claim, input.settledJoinVersion) ||
          state.settledJoinVersion !== input.settledJoinVersion
        ) {
          return "retry";
        }
        const result = complete();
        if (result !== "applied" && result !== "already_applied" && result !== "retry") {
          throw new Error("Completion fence callback must return synchronously");
        }
        if (result === "retry") return result;
        state.state = "completed";
        state.claim = null;
        options?.onCompleted?.(input.pushId);
        return result;
      });
    },

    async listRecoverableSettlementIds() {
      const now = new Date();
      return [...settlements.values()]
        .filter(
          (state) =>
            state.state === "pending" &&
            state.availableAt <= now &&
            (!state.claim || state.claim.leaseExpiresAt <= now),
        )
        .map(({ pending }) => pending.push.id);
    },
  };

  return store;
}

function isOwned(
  state: SettlementState | undefined,
  claim: SettlementClaim,
  joinVersion?: number,
): state is SettlementState {
  return Boolean(
    state &&
      state.state === "pending" &&
      state.claim?.token === claim.token &&
      state.claim.epoch === claim.epoch &&
      state.claim.leaseExpiresAt > new Date() &&
      (joinVersion === undefined || state.pending.joinVersion === joinVersion),
  );
}

function snapshot(
  state: SettlementState,
  materialize?: (pending: PendingLiveSettlement) => PendingLiveSettlement,
): PendingLiveSettlement {
  if (!state.claim)
    throw new Error(`Pending branch push settlement ${state.pending.push.id} is not owned`);
  const pending = {
    ...clonePending(state.pending, state.claim),
    settledJoinVersion: state.settledJoinVersion,
    attemptCount: state.attemptCount,
  };
  return materialize?.(pending) ?? pending;
}

function clonePending(
  pending: PendingLiveSettlement,
  claim: SettlementClaim,
): PendingLiveSettlement {
  return {
    ...pending,
    postCutUpdates: [...pending.postCutUpdates],
    claim: { ...claim, leaseExpiresAt: new Date(claim.leaseExpiresAt) },
  };
}

function admissionSourceKey(input: SettlementAdmission): string {
  return `${input.source.kind}:${input.source.id}`;
}
