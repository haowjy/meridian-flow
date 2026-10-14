/** Domain port for atomically recording normalized change trails. */

import { isUuid } from "../../../../shared/uuid.js";
import { type NoticeInput, parseNoticeInput } from "../../../notices/index.js";
import type { TrailContributionReplacement } from "../branch-push-contracts.js";
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
  transactionalNotice?: NoticeInput;
};

/** A stored trail seed that does not parse: corruption, never a transient failure. */
export class DurableTrailSeedError extends Error {
  readonly name = "DurableTrailSeedError";
}

/**
 * Total parser for the frozen settlement trail input stored in jsonb. Every
 * validation failure, including the shared nested parsers' plain errors, leaves
 * as `DurableTrailSeedError` so corruption is never retried as transient.
 */
export function parseDurableTrailSeedV1(value: unknown): DurableTrailRecord {
  try {
    return decodeDurableTrailSeedV1(value);
  } catch (cause) {
    if (cause instanceof DurableTrailSeedError) throw cause;
    throw new DurableTrailSeedError("Invalid durable trail seed v1", { cause });
  }
}

function decodeDurableTrailSeedV1(value: unknown): DurableTrailRecord {
  if (!isRecord(value)) throw new DurableTrailSeedError("Durable trail seed must be an object");
  const {
    documentId,
    documentTitle,
    receiptId,
    threadIds,
    journalOwners,
    changes,
    transactionalNotice,
  } = value;
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
    throw new DurableTrailSeedError("Invalid durable trail seed v1");
  }
  const owners = journalOwners.map(parseTrailOwner);
  const decodedChanges = changes.map((change, ordinal) => {
    if (!isRecord(change))
      throw new DurableTrailSeedError("Durable trail change must be an object");
    const sequence =
      Number.isSafeInteger(change.sequence) && (change.sequence as number) >= 0
        ? (change.sequence as number)
        : (() => {
            throw new DurableTrailSeedError(
              "Durable trail change sequence must be a non-negative integer",
            );
          })();
    return {
      change: { ...change, ordinal },
      metadata: { owner: parseTrailOwner(change.owner), sequence },
    };
  });
  const parsedChanges = parseTrailChangesV1(decodedChanges.map(({ change }) => change)).map(
    ({ ordinal: _ordinal, ...change }, index) => ({
      ...change,
      ...(decodedChanges[index]?.metadata as { owner: TrailOwner | null; sequence: number }),
    }),
  );
  return {
    documentId,
    documentTitle,
    receiptId,
    threadIds: [...threadIds] as string[],
    journalOwners: owners,
    changes: parsedChanges,
    ...(transactionalNotice === undefined
      ? {}
      : { transactionalNotice: parseNoticeInput(transactionalNotice) }),
  };
}

function parseTrailOwner(value: unknown): TrailOwner | null {
  if (value === null) return null;
  if (!isRecord(value) || !isUuidString(value.threadId) || !isUuidString(value.turnId)) {
    throw new DurableTrailSeedError("Invalid durable trail owner");
  }
  return { threadId: value.threadId, turnId: value.turnId };
}

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && isUuid(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ChangeTrailPersistence = {
  record(input: {
    trails: readonly NormalizedTrail[];
    documentTitles: ReadonlyMap<string, string>;
    settlementRefinement?: {
      pushIds: readonly string[];
      currentVersion: boolean;
      /** Of `pushIds`, those whose provisional changes leave the trail entirely. */
      retiredPushIds?: readonly string[];
    };
  }): Promise<readonly CommittedChangeTrailProjection[]>;
  /**
   * Replaces several pushes' provisional contributions in one pass over each trail.
   * A `retire` contribution removes the push's changes (it never reached live); its
   * replacement names the owners only.
   */
  replacePushContributions(
    contributions: readonly {
      pushId: string;
      replacement: TrailContributionReplacement;
      retire?: boolean;
    }[],
    context: { refineCurrentVersion: boolean },
  ): Promise<readonly CommittedChangeTrailProjection[]>;
  reopenOwners(owners: readonly NormalizedTrail["owner"][]): Promise<void>;
};

export type CommittedChangeTrailProjection = {
  trailId: string;
  owner: NormalizedTrail["owner"];
  documentId: string;
  projectionRevision: number;
  changes: Array<TrailChangeV1 & { admittedByUserId: string | null }>;
};
