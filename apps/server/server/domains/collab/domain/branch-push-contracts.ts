/** Neutral branch journal and auto-push contracts shared across collab domain services. */
import type { LineageRange } from "@meridian/agent-edit";
import type { ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";

export type BranchJournalRow = {
  id: number;
  branchId: string;
  generation: number;
  wId: number | null;
  source: "agent" | "writer";
  threadId: ThreadId | null;
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  /** Immutable live-journal watermark captured with this draft mutation. */
  draftBaseUpdateSeq: number;
  status: "active" | "pushed" | "discarded" | "rollback_pending";
  updateMeta?: unknown;
};

export function branchJournalRevision(
  rows: readonly Pick<BranchJournalRow, "id" | "status">[],
): string {
  return [...rows]
    .sort((left, right) => left.id - right.id)
    .map((row) => `${row.id}:${row.status}`)
    .join(",");
}

export function branchUpdateMetaWithReplacementScopes(
  updateMeta: unknown,
  replacementScopes: readonly (readonly LineageRange[])[],
  replacementScopesComplete: boolean,
): unknown {
  return {
    ...(isRecord(updateMeta) ? updateMeta : {}),
    replacementScopes: replacementScopes.map((scope) => scope.map((range) => ({ ...range }))),
    replacementScopesComplete,
  };
}

export function replacementScopesFromBranchRow(row: Pick<BranchJournalRow, "updateMeta">): {
  complete: boolean;
  scopes: LineageRange[][];
} {
  if (!isRecord(row.updateMeta) || !Array.isArray(row.updateMeta.replacementScopes)) {
    return { complete: false, scopes: [] };
  }
  return {
    complete: row.updateMeta.replacementScopesComplete === true,
    scopes: row.updateMeta.replacementScopes.flatMap((scope) =>
      Array.isArray(scope) && scope.length > 0 && scope.every(isLineageRange)
        ? [scope.map((range) => ({ ...range }))]
        : [],
    ),
  };
}

export type AutoBranchPushPort = {
  pushAutoBranchAfterThreadPeerWrite(input: {
    workDraftBranchId: string;
    pushedByUserId?: UserId;
  }): Promise<{ status: string; [key: string]: unknown }>;
};

function isLineageRange(value: unknown): value is LineageRange {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.clientID) &&
    Number.isSafeInteger(value.clock) &&
    Number.isSafeInteger(value.length) &&
    (value.clientID as number) >= 0 &&
    (value.clock as number) >= 0 &&
    (value.length as number) > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
