/** Project-local lineage lifetime and identity reservation over native browser locks. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import {
  type CrossContextLockManager,
  nativeLocks,
  tryAcquireExclusiveLock,
} from "@/core/cross-context-locks";

export interface LocalUntitledCrossContextLease {
  release(): Promise<void>;
}
export interface LocalUntitledCrossContextLeasePort {
  tryAcquire(
    projectId: ProjectId,
    lineageHandle: string,
  ): Promise<LocalUntitledCrossContextLease | null>;
}
export interface LocalIdentityReservationPort {
  tryReserve(
    projectId: ProjectId,
    documentId: DocumentId,
  ): Promise<{ kind: "unavailable" } | { kind: "reserved"; release(): Promise<void> }>;
}
export function createLocalIdentityReservationPort(input: {
  accountId: AccountId;
  locks?: CrossContextLockManager | null;
}): LocalIdentityReservationPort {
  const locks = input.locks === undefined ? nativeLocks() : input.locks;
  return {
    async tryReserve(projectId, documentId) {
      if (!locks) return { kind: "unavailable" };
      const reservation = await tryAcquireExclusiveLock(
        locks,
        `meridian:f1j:v2:local-untitled-identity-reservation/${encodeURIComponent(input.accountId)}/${encodeURIComponent(projectId)}/${encodeURIComponent(documentId)}`,
      );
      return reservation
        ? { kind: "reserved", release: reservation.release }
        : { kind: "unavailable" };
    },
  };
}
export function createLocalUntitledCrossContextLeasePort(input: {
  accountId: AccountId;
  locks?: CrossContextLockManager | null;
  epochSignal?: AbortSignal;
}): LocalUntitledCrossContextLeasePort {
  const locks = input.locks === undefined ? nativeLocks() : input.locks;
  return {
    async tryAcquire(projectId, lineageHandle) {
      if (input.epochSignal?.aborted)
        throw new Error("Account document session runtime is closing");
      const lease = locks
        ? await tryAcquireExclusiveLock(
            locks,
            `meridian:f1j:v2:local-untitled-lineage-lifetime/${encodeURIComponent(input.accountId)}/${encodeURIComponent(projectId)}/${encodeURIComponent(lineageHandle)}`,
          )
        : null;
      if (!input.epochSignal?.aborted) return lease;
      await lease?.release();
      throw new Error("Account document session runtime is closing");
    },
  };
}
