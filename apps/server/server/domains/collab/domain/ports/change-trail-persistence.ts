/** Domain port for atomically recording normalized change trails. */

import type {
  NormalizedTrail,
  RawTrailChange,
  TrailChangeV1,
  TrailOwner,
} from "../trail-read-kernel.js";
import { parseTrailChangesV1 } from "../trail-read-kernel.js";

export type DurableTrailRecord = {
  documentId: string;
  documentTitle: string;
  receiptId: string;
  threadIds: readonly string[];
  journalOwners: readonly (TrailOwner | null)[];
  changes: readonly RawTrailChange[];
};

/** Total parser for the frozen settlement trail input stored in jsonb. */
export function parseDurableTrailSeedV1(value: unknown): DurableTrailRecord {
  if (!isRecord(value)) throw new Error("Durable trail seed must be an object");
  const { documentId, documentTitle, receiptId, threadIds, journalOwners, changes } = value;
  if (
    typeof documentId !== "string" ||
    !isUuid(documentId) ||
    typeof documentTitle !== "string" ||
    typeof receiptId !== "string" ||
    !isUuid(receiptId) ||
    !Array.isArray(threadIds) ||
    !threadIds.every((id) => typeof id === "string" && isUuid(id)) ||
    !Array.isArray(journalOwners) ||
    !Array.isArray(changes)
  ) {
    throw new Error("Invalid durable trail seed v1");
  }
  const owners = journalOwners.map(parseTrailOwner);
  const rawMetadata = changes.map((change) => {
    if (!isRecord(change)) throw new Error("Durable trail change must be an object");
    return {
      owner: parseTrailOwner(change.owner),
      sequence:
        Number.isSafeInteger(change.sequence) && (change.sequence as number) >= 0
          ? (change.sequence as number)
          : (() => {
              throw new Error("Durable trail change sequence must be a non-negative integer");
            })(),
    };
  });
  const parsedChanges = parseTrailChangesV1(
    changes.map((change, ordinal) => {
      if (!isRecord(change)) throw new Error("Durable trail change must be an object");
      return { ...change, ordinal, reversible: false };
    }),
  ).map(({ ordinal: _ordinal, reversible: _reversible, ...change }, index) => ({
    ...change,
    ...(rawMetadata[index] as { owner: TrailOwner | null; sequence: number }),
  }));
  return {
    documentId,
    documentTitle,
    receiptId,
    threadIds: [...threadIds] as string[],
    journalOwners: owners,
    changes: parsedChanges,
  };
}

function parseTrailOwner(value: unknown): TrailOwner | null {
  if (value === null) return null;
  if (!isRecord(value) || !isUuidString(value.threadId) || !isUuidString(value.turnId)) {
    throw new Error("Invalid durable trail owner");
  }
  return { threadId: value.threadId, turnId: value.turnId };
}

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && isUuid(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ChangeTrailPersistence = {
  /**
   * Returns exactly the post-fold document replace-sets committed by this write.
   * Revisions are durable and monotonic per (trailId, documentId).
   */
  record(input: {
    trails: readonly NormalizedTrail[];
    documentTitles: ReadonlyMap<string, string>;
    /** Refines the current push's provisional trail without publishing a second version. */
    refineCurrentVersion?: boolean;
    /** Replaces this push's prior aggregate contribution with the supplied classification. */
    replacePushId?: string;
  }): Promise<readonly CommittedChangeTrailProjection[]>;
  reopenOwners(owners: readonly NormalizedTrail["owner"][]): Promise<void>;
};

export type CommittedChangeTrailProjection = {
  trailId: string;
  owner: NormalizedTrail["owner"];
  documentId: string;
  projectionRevision: number;
  changes: readonly TrailChangeV1[];
};
