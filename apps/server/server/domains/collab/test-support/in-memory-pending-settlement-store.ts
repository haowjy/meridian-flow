/** Stateful pending-settlement store for branch-push parity tests. */

import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import type {
  PendingLiveSettlement,
  PendingSettlementBatch,
  SettlementClaim,
} from "../domain/branch-push-contracts.js";
import type {
  PendingSettlementStore,
  SettlementAdmission,
} from "../domain/ports/pending-settlement-store.js";

const LEASE_MS = 30_000;

type MemberState = {
  pending: PendingLiveSettlement;
  joinedSources: Set<string>;
};

type BatchState = {
  batchId: string;
  members: MemberState[];
  state: "pending" | "blocked" | "completed";
  claim: SettlementClaim | null;
  claimEpoch: number;
  availableAt: Date;
  attemptCount: number;
  lastError?: string;
  lastErrorCode?: string;
};

export type InMemoryPendingSettlementStore = PendingSettlementStore & {
  /** Mirrors the durable staging performed inside a successful batch commit. */
  stage(input: {
    batchId: string;
    claimToken: string;
    members: readonly Omit<PendingLiveSettlement, "postCutUpdates" | "joinVersion">[];
  }): void;
};

export function createInMemoryPendingSettlementStore(options?: {
  onCompleted?: (pushId: number) => void;
}): InMemoryPendingSettlementStore {
  const batches = new Map<string, BatchState>();
  // One fence per batch, as the batch row serializes its owners.
  const fences = new KeyedMutex();

  const store: InMemoryPendingSettlementStore = {
    stage(input) {
      const now = new Date();
      batches.set(input.batchId, {
        batchId: input.batchId,
        members: [...input.members]
          .sort((left, right) => left.push.documentId.localeCompare(right.push.documentId))
          .map((member) => ({
            pending: { ...member, postCutUpdates: [], joinVersion: 0 },
            joinedSources: new Set(),
          })),
        state: "pending",
        claim: {
          token: input.claimToken,
          epoch: 1,
          kind: "warm",
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        },
        claimEpoch: 1,
        availableAt: now,
        attemptCount: 0,
      });
    },

    async joinAdmission(input) {
      for (const batch of [...batches.values()]) {
        await fences.run(batch.batchId, async () => {
          if (batch.state === "completed") return;
          for (const member of batch.members) {
            if (
              member.pending.push.documentId !== input.documentId ||
              String(member.pending.push.id) === input.excludePushId
            ) {
              continue;
            }
            const sourceKey = admissionSourceKey(input);
            if (member.joinedSources.has(sourceKey)) continue;
            member.joinedSources.add(sourceKey);
            member.pending = {
              ...member.pending,
              postCutUpdates: [...member.pending.postCutUpdates, input.update],
              joinVersion: member.pending.joinVersion + 1,
            };
          }
        });
      }
    },

    async loadSettlementBatch({ batchId, owner }) {
      const batch = batches.get(batchId);
      if (
        batch?.state !== "pending" ||
        batch.claim?.token !== owner.token ||
        batch.claim.epoch !== owner.epoch
      ) {
        return null;
      }
      return snapshot(batch);
    },

    async claimRecoverableBatch(input) {
      return fences.run(input.batchId, async () => {
        const batch = batches.get(input.batchId);
        const now = new Date();
        if (
          batch?.state !== "pending" ||
          batch.availableAt > now ||
          (batch.claim && batch.claim.leaseExpiresAt > now)
        ) {
          return null;
        }
        batch.claimEpoch += 1;
        batch.claim = {
          token: input.token,
          epoch: batch.claimEpoch,
          kind: "recovery",
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        };
        return snapshot(batch);
      });
    },

    async renewClaim(input) {
      return fences.run(input.batchId, async () => {
        const batch = batches.get(input.batchId);
        if (!isOwned(batch, input.claim)) return null;
        const claim = { ...input.claim, leaseExpiresAt: new Date(Date.now() + LEASE_MS) };
        batch.claim = claim;
        return { ...claim };
      });
    },

    async recordFailure(input) {
      return fences.run(input.batchId, async () => {
        const batch = batches.get(input.batchId);
        if (!isOwned(batch, input.claim)) return false;
        batch.attemptCount += 1;
        batch.lastError = input.error instanceof Error ? input.error.message : String(input.error);
        batch.claim = null;
        const backoffSeconds = Math.min(60, 2 ** Math.min(6, batch.attemptCount));
        batch.availableAt = new Date(Date.now() + backoffSeconds * 1_000);
        return true;
      });
    },

    async block(input) {
      return fences.run(input.batchId, async () => {
        const batch = batches.get(input.batchId);
        if (!isOwned(batch, input.claim)) return false;
        batch.state = "blocked";
        batch.lastErrorCode = input.code;
        batch.lastError = input.error;
        batch.claim = null;
        return true;
      });
    },

    async completeBatch(input) {
      const result = await fences.run(input.batchId, async () => {
        const batch = batches.get(input.batchId);
        if (!isOwned(batch, input.claim)) return "retry" as const;
        if (
          batch.members.length !== input.members.length ||
          input.members.some(
            (member) =>
              batch.members.find(({ pending }) => pending.push.id === member.push.id)?.pending
                .joinVersion !== member.joinVersion,
          )
        ) {
          return "retry" as const;
        }
        const decision = input.recheck(
          batch.members.map(({ pending }) => ({
            pushId: pending.push.id,
            documentId: pending.push.documentId,
            lockCutUpdate: pending.lockCutUpdate,
            postCutUpdates: pending.postCutUpdates,
            pushUpdate: pending.pushUpdate,
          })),
        );
        if (decision !== "commit" && decision !== "retry") {
          throw new Error("Batch settlement recheck must return synchronously");
        }
        if (decision === "retry") return decision;
        batch.state = "completed";
        batch.claim = null;
        return "commit" as const;
      });
      if (result === "retry") return { status: "retry" as const };
      input.afterCommit(input.members.map(({ push }) => push.documentId));
      for (const member of input.members) options?.onCompleted?.(member.push.id);
      return { status: "completed" as const, projections: [], held: [], outcomes: [] };
    },

    // This store models no publication steps: every check proceeds.
    async checkPublication(input) {
      return { kind: "proceed" as const, hold: [], payloads: input.payloads };
    },

    async listRecoverableBatchIds() {
      const now = new Date();
      return [...batches.values()]
        .filter(
          (batch) =>
            batch.state === "pending" &&
            batch.availableAt <= now &&
            (!batch.claim || batch.claim.leaseExpiresAt <= now),
        )
        .map(({ batchId }) => batchId);
    },
  };

  return store;
}

function isOwned(batch: BatchState | undefined, claim: SettlementClaim): batch is BatchState {
  return Boolean(
    batch &&
      batch.state === "pending" &&
      batch.claim?.token === claim.token &&
      batch.claim.epoch === claim.epoch &&
      batch.claim.leaseExpiresAt > new Date(),
  );
}

function snapshot(batch: BatchState): PendingSettlementBatch {
  if (!batch.claim) throw new Error(`Pending settlement batch ${batch.batchId} is not owned`);
  return {
    batchId: batch.batchId,
    claim: { ...batch.claim, leaseExpiresAt: new Date(batch.claim.leaseExpiresAt) },
    attemptCount: batch.attemptCount,
    payloads: new Map(),
    members: batch.members.map(({ pending }) => ({
      ...pending,
      postCutUpdates: [...pending.postCutUpdates],
    })),
  };
}

function admissionSourceKey(input: SettlementAdmission): string {
  return `${input.source.kind}:${input.source.id}`;
}
