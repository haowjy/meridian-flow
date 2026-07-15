/** Pure change-trail normalization and durable Yjs navigation targets. */
import {
  type BlockItemId,
  encodeNavigationPosition,
  getBlockItemId,
  type LiveBlockRangeTarget,
  validateLiveBlockRange,
} from "@meridian/agent-edit";
import * as Y from "yjs";

export type HistoricalBody =
  | { status: "available"; markdown: string }
  | { status: "unavailable"; reason: "not_captured" | "compacted" | "redacted" };

/** Stable block identity. Display hashlines are deliberately excluded. */
export type CanonicalBlockIdentityV1 = {
  documentId: string;
  clientID: number;
  clock: number;
};

export type NavigationTargetV1 =
  | { kind: "live_block_range"; relStart: string; relEnd: string; targetBlockId: BlockItemId }
  | {
      kind: "deletion_boundary";
      position: string;
      affinity: "before_next" | "after_previous" | "document_start";
    }
  | { kind: "unavailable"; reason: "capture_failed" | "unsupported_mapping" };

export type TrailChangeV1 = {
  changeId: string;
  ordinal: number;
  documentId: string | null;
  pushId: string | null;
  receiptId: string | null;
  kind: "insert" | "modify" | "delete";
  beforeBlockId: string | null;
  afterBlockId: string | null;
  beforeBlockIdentity?: CanonicalBlockIdentityV1 | null;
  afterBlockIdentity?: CanonicalBlockIdentityV1 | null;
  beforeText: string | null;
  afterTextAtReceipt: string | null;
  navigation: NavigationTargetV1;
  swept: null | {
    affectedBlockHash: string;
    affectedBlockIdentity?: CanonicalBlockIdentityV1;
    removed: HistoricalBody;
    beforeContentRef: number | null;
  };
  writerProtection?:
    | { kind: "sweep"; body: HistoricalBody }
    | { kind: "resurrection"; body: HistoricalBody };
  forwardActions?: Partial<Record<"restore" | "delete-again", TrailForwardActionStateV1>>;
  reversible: false;
};

export type TrailForwardActionStateV1 =
  | {
      status: "committed";
      update: string;
      expectedLiveStateHash: string;
    }
  | { status: "applied"; updateId: number }
  | { status: "settled"; outcome: "anchor_unavailable" };

export type ChangeTrailShellV1 = {
  trailId: string;
  owner:
    | { kind: "turn"; threadId: string; turnId: string }
    | { kind: "shared"; threadId: string; turnId: null };
  state: "building" | "settling" | "settled";
  version: number;
  changeCount: number;
  sweptChangeCount: number;
  documentCount: number;
  updatedAt: string;
  settledAt: string | null;
};

export type ChangeTrailDocumentDetailV1 = {
  trailId: string;
  documentId: string;
  documentTitle: string;
  changes: TrailChangeV1[];
  /** The durable detail remains readable, but its live document cannot be opened. */
  unavailable?: true;
};

const ROOT_NAME = "prosemirror";

export function encodeTrailPosition(position: Y.RelativePosition): string {
  return encodeNavigationPosition(position);
}

export function rootRelativePosition(doc: Y.Doc, index: number): Y.RelativePosition {
  return Y.createRelativePositionFromTypeIndex(doc.getXmlFragment(ROOT_NAME), index);
}

export function liveBlockTarget(doc: Y.Doc, block: Y.XmlElement): NavigationTargetV1 {
  try {
    const root = doc.getXmlFragment(ROOT_NAME);
    const index = root.toArray().indexOf(block);
    if (index < 0) return { kind: "unavailable", reason: "capture_failed" };
    return {
      kind: "live_block_range",
      relStart: encodeTrailPosition(Y.createRelativePositionFromTypeIndex(root, index)),
      relEnd: encodeTrailPosition(Y.createRelativePositionFromTypeIndex(root, index + 1)),
      targetBlockId: getBlockItemId(block),
    };
  } catch {
    return { kind: "unavailable", reason: "capture_failed" };
  }
}

export function deletionBoundaryTarget(input: {
  doc: Y.Doc;
  next?: Y.XmlElement | null;
  previous?: Y.XmlElement | null;
}): NavigationTargetV1 {
  try {
    const root = input.doc.getXmlFragment(ROOT_NAME);
    const nextIndex = input.next ? root.toArray().indexOf(input.next) : -1;
    if (nextIndex >= 0) {
      return {
        kind: "deletion_boundary",
        position: encodeTrailPosition(Y.createRelativePositionFromTypeIndex(root, nextIndex)),
        affinity: "before_next",
      };
    }
    const previousIndex = input.previous ? root.toArray().indexOf(input.previous) : -1;
    if (previousIndex >= 0) {
      return {
        kind: "deletion_boundary",
        position: encodeTrailPosition(
          Y.createRelativePositionFromTypeIndex(root, previousIndex + 1),
        ),
        affinity: "after_previous",
      };
    }
    if (root.length === 0) {
      return {
        kind: "deletion_boundary",
        position: encodeTrailPosition(Y.createRelativePositionFromTypeIndex(root, 0)),
        affinity: "document_start",
      };
    }
    return { kind: "unavailable", reason: "capture_failed" };
  } catch {
    return { kind: "unavailable", reason: "capture_failed" };
  }
}

export function validateLiveBlockTarget(input: {
  doc: Y.Doc;
  target: NavigationTargetV1;
}): boolean {
  if (input.target.kind !== "live_block_range") return false;
  const resolved = validateLiveBlockRange({
    doc: input.doc,
    target: input.target as LiveBlockRangeTarget,
  });
  return Boolean(resolved);
}

export type ReplacementOperation = {
  removedBlockHashes: readonly string[];
  insertedBlocks: readonly { blockId: string; block: Y.XmlElement }[];
  ambiguous?: boolean;
};

export function navigationForSweptBlock(input: {
  affectedBlockHash: string;
  afterDoc: Y.Doc;
  operations: readonly ReplacementOperation[];
  nextSurvivor?: Y.XmlElement | null;
  previousSurvivor?: Y.XmlElement | null;
}): { outcome: "modify" | "delete"; navigation: NavigationTargetV1 } {
  const candidates = input.operations.filter((operation) =>
    operation.removedBlockHashes.includes(input.affectedBlockHash),
  );
  const operation = candidates.length === 1 ? candidates[0] : undefined;
  if (
    operation &&
    !operation.ambiguous &&
    operation.removedBlockHashes.length === 1 &&
    operation.insertedBlocks.length === 1
  ) {
    const inserted = operation.insertedBlocks[0];
    return {
      outcome: "modify",
      navigation: liveBlockTarget(input.afterDoc, inserted.block),
    };
  }
  return {
    outcome: "delete",
    navigation: deletionBoundaryTarget({
      doc: input.afterDoc,
      next: input.nextSurvivor,
      previous: input.previousSurvivor,
    }),
  };
}

export function bodyFromHashline(serialized: string | null): HistoricalBody {
  if (serialized === null) return { status: "unavailable", reason: "not_captured" };
  const separator = serialized.indexOf("|");
  return {
    status: "available",
    markdown: separator < 0 ? serialized : serialized.slice(separator + 1),
  };
}

export type TrailOwner = { threadId: string; turnId: string };
export type RawTrailChange = Omit<TrailChangeV1, "ordinal" | "reversible"> & {
  owner: TrailOwner | null;
  sequence: number;
};

export type RawTrailPush = {
  pushId: string;
  receiptId: string;
  threadId: string;
  changes: readonly RawTrailChange[];
  journalOwners: readonly (TrailOwner | null)[];
};

export type NormalizedTrail = {
  owner:
    | { kind: "turn"; threadId: string; turnId: string }
    | { kind: "shared"; threadId: string; turnId: null };
  changes: TrailChangeV1[];
  counts: { changes: number; swept: number; documents: number };
};

function ownerKey(owner: NormalizedTrail["owner"]): string {
  return owner.kind === "turn"
    ? `turn:${owner.threadId}:${owner.turnId}`
    : `shared:${owner.threadId}`;
}

export function normalizeTrailPushes(pushes: readonly RawTrailPush[]): NormalizedTrail[] {
  const grouped = new Map<string, { owner: NormalizedTrail["owner"]; changes: RawTrailChange[] }>();
  const append = (owner: NormalizedTrail["owner"], change: RawTrailChange) => {
    const key = ownerKey(owner);
    const group = grouped.get(key) ?? { owner, changes: [] };
    group.changes.push(change);
    grouped.set(key, group);
  };
  for (const push of pushes) {
    const distinctOwners = new Map(
      push.journalOwners.flatMap((owner) =>
        owner ? [[`${owner.threadId}:${owner.turnId}`, owner] as const] : [],
      ),
    );
    const sweptOwner =
      push.journalOwners.length > 0 &&
      !push.journalOwners.includes(null) &&
      distinctOwners.size === 1
        ? [...distinctOwners.values()][0]
        : null;
    for (const change of push.changes) {
      if (change.swept) {
        const owner = sweptOwner;
        append(
          owner
            ? { kind: "turn", threadId: owner.threadId, turnId: owner.turnId }
            : { kind: "shared", threadId: push.threadId, turnId: null },
          change,
        );
      } else if (change.owner) {
        append({ kind: "turn", ...change.owner }, change);
      }
    }
  }
  return [...grouped.values()]
    .sort((left, right) => ownerKey(left.owner).localeCompare(ownerKey(right.owner)))
    .map(({ owner, changes }) => {
      const folded = foldChanges(changes);
      return {
        owner,
        changes: folded,
        counts: {
          changes: folded.length,
          swept: folded.filter((change) => change.swept !== null).length,
          documents: new Set(
            folded.flatMap((change) => (change.documentId ? [change.documentId] : [])),
          ).size,
        },
      };
    });
}

function foldChanges(changes: readonly RawTrailChange[]): TrailChangeV1[] {
  const ordered = [...changes].sort(
    (a, b) => a.sequence - b.sequence || a.changeId.localeCompare(b.changeId),
  );
  const folded = new Map<string, RawTrailChange>();
  for (const change of ordered) {
    const identity = canonicalChangeKey(change);
    const previous = folded.get(identity);
    if (!previous) {
      folded.set(identity, change);
      continue;
    }
    const combined: RawTrailChange = {
      ...change,
      changeId: previous.changeId,
      kind:
        previous.beforeText === null
          ? "insert"
          : change.afterTextAtReceipt === null
            ? "delete"
            : "modify",
      beforeBlockId: previous.beforeBlockId,
      beforeText: previous.beforeText,
      swept: change.swept ?? previous.swept,
    };
    if (combined.beforeText === combined.afterTextAtReceipt) folded.delete(identity);
    else folded.set(identity, combined);
  }
  return [...folded.values()].map(({ owner: _owner, sequence: _sequence, ...change }, ordinal) => ({
    ...change,
    ordinal,
    reversible: false,
  }));
}

export function canonicalBlockKey(identity: CanonicalBlockIdentityV1): string {
  return `${identity.documentId}:${identity.clientID}:${identity.clock}`;
}

export function canonicalChangeKey(
  change: Pick<
    TrailChangeV1,
    | "documentId"
    | "changeId"
    | "beforeBlockId"
    | "afterBlockId"
    | "beforeBlockIdentity"
    | "afterBlockIdentity"
  >,
): string {
  const identity = change.beforeBlockIdentity ?? change.afterBlockIdentity;
  if (!identity) {
    throw new Error(`trail change ${change.changeId} is missing canonical block identity`);
  }
  return canonicalBlockKey(identity);
}
