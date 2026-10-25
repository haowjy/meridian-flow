/**
 * Causal order of placement intents across every file and folder journal. Each placement is
 * admitted once, behind the unresolved intents it conflicts with; projection folds unresolved
 * intents in that order, dispatch waits on the predecessors, and Undo asks who owns a subject's
 * placement. All three read this one record instead of rebuilding history from adjacency.
 */
import { isProjectScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type { ResourcePlacement } from "./folder-projection";
import type {
  FolderNamespaceRecord,
  NamespaceIntent,
  ParentRef,
  PlacementAdmission,
  PlacementPredecessor,
  ResourceRecord,
} from "./resource-records";

/** One key per parent that `sameParent` treats as equal; project areas ignore the owner. */
export function placementParentKey(parent: ParentRef): string {
  if (parent.kind === "folder") return `folder:${parent.folderId}`;
  if (isProjectScopedScheme(parent.scheme)) return `root:${parent.scheme}`;
  return `root:${parent.scheme}:${parent.owner.workId ?? ""}:${parent.owner.rootThreadId ?? ""}:${parent.owner.chatId ?? ""}`;
}

/** A placement intent in a journal, with the identity it places. */
export type PlacementOp = {
  kind: "resource" | "folder";
  handle: string;
  /** The entry id the catalog and anchors name. */
  subject: string;
  intent: NamespaceIntent & { admission: PlacementAdmission };
  /** The accepted operation whose canonical refresh is still outstanding for this identity. */
  refreshing?: string;
};

/**
 * Whether the op still shapes the displayed list: unresolved, or accepted with the canonical
 * observation that covers it not yet installed. Past that point the catalog is the truth.
 */
export function placementShapesList(op: PlacementOp): boolean {
  return (
    placementUnresolved(op.intent.state) ||
    (op.intent.state === "settled" &&
      op.intent.operationId !== undefined &&
      op.intent.operationId === op.refreshing)
  );
}

/** Every admitted intent in the snapshot, in admission order. */
export function placementOps(snapshot: {
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
}): PlacementOp[] {
  const ops: PlacementOp[] = [];
  const add = (
    kind: PlacementOp["kind"],
    handle: string,
    subject: string,
    intents: readonly NamespaceIntent[],
    refreshing: string | undefined,
  ) => {
    for (const intent of intents)
      if (intent.admission)
        ops.push({
          kind,
          handle,
          subject,
          intent: intent as PlacementOp["intent"],
          ...(refreshing ? { refreshing } : {}),
        });
  };
  for (const record of snapshot.records)
    add(
      "resource",
      record.resource.handle,
      record.resource.identity.documentId,
      record.intents,
      record.resource.obligations.canonicalRefresh?.operationId,
    );
  for (const folder of snapshot.folders)
    add(
      "folder",
      folder.handle,
      folder.folderId,
      folder.intents,
      folder.canonicalRefresh?.operationId,
    );
  return ops.sort((left, right) => left.intent.admission.order - right.intent.admission.order);
}

/** Work the server has not finished with: it still shapes what later placements read. */
export function placementUnresolved(state: NamespaceIntent["state"]): boolean {
  return state === "pending" || state === "submitted" || state === "received";
}

/** Work that never took effect, so what depended on its result lost its premise. */
function placementFailed(state: NamespaceIntent["state"]): boolean {
  return (
    state === "needs-repair" ||
    state === "cancelled" ||
    state === "superseded" ||
    state === "unexecutable-after-terminal"
  );
}

export type PlacementSpec = {
  /** The entry id placed, moved or deleted. */
  subject: string;
  /** Where it sits now, as the projection shows it; null for a new document. */
  source: ParentRef | null;
  /** Where it goes; null for a deletion. */
  destination: ParentRef | null;
  position?: ContextSiblingPosition;
};

function anchorOf(position: ContextSiblingPosition | undefined): string | undefined {
  return position && "siblingId" in position ? position.siblingId : undefined;
}

function scopeOf(
  spec: PlacementSpec,
  parentOfFolder: (folderId: string) => ParentRef | null,
): string[] {
  const keys = new Set([`entry:${spec.subject}`]);
  if (spec.source) keys.add(`parent:${placementParentKey(spec.source)}`);
  if (spec.destination) {
    keys.add(`parent:${placementParentKey(spec.destination)}`);
    // Moving or deleting an ancestor changes what the destination means.
    const seen = new Set<string>();
    for (
      let parent: ParentRef | null = spec.destination;
      parent?.kind === "folder" && !seen.has(parent.folderId);
      parent = parentOfFolder(parent.folderId)
    ) {
      seen.add(parent.folderId);
      keys.add(`entry:${parent.folderId}`);
    }
  }
  const anchor = anchorOf(spec.position);
  if (anchor) keys.add(`entry:${anchor}`);
  return [...keys].sort();
}

/**
 * The admission record for a new placement. Call it under the account's admission lock with a
 * snapshot read inside that lock: the order is one past the highest ever admitted, and the
 * predecessors are every unresolved intent whose scope overlaps (less those another predecessor
 * already waits on, unless this placement is anchored on them).
 */
export function capturePlacementAdmission(input: {
  snapshot: { records: readonly ResourceRecord[]; folders: readonly FolderNamespaceRecord[] };
  placement: Pick<ResourcePlacement, "parentForFolder">;
  spec: PlacementSpec;
}): PlacementAdmission {
  const scope = scopeOf(input.spec, input.placement.parentForFolder);
  const mine = new Set(scope);
  const anchor = anchorOf(input.spec.position);
  const ops = placementOps(input.snapshot);
  const overlapping = ops.filter(
    (op) =>
      placementUnresolved(op.intent.state) &&
      op.intent.admission.scope.some((key) => mine.has(key)),
  );
  const covered = new Set(
    overlapping.flatMap((op) => op.intent.admission.predecessors.map((p) => p.intentId)),
  );
  const predecessors: PlacementPredecessor[] = overlapping.flatMap((op) => {
    const anchored = op.subject === anchor;
    return covered.has(op.intent.intentId) && !anchored
      ? []
      : [
          {
            kind: op.kind,
            handle: op.handle,
            intentId: op.intent.intentId,
            ...(anchored ? { anchor: true as const } : {}),
          },
        ];
  });
  return {
    order: (ops.at(-1)?.intent.admission.order ?? 0) + 1,
    scope,
    predecessors,
  };
}

export type PlacementVerdict = "go" | "wait" | "repair";

/**
 * Whether a pending placement may dispatch. It waits while any predecessor is unresolved,
 * whatever that predecessor's runner is doing. Once they are resolved it goes, unless a
 * predecessor it was anchored on never took effect: its premise changed, so the writer repairs it
 * rather than the server executing it against a different list.
 */
export function placementDispatchVerdict(
  intent: NamespaceIntent,
  predecessorIntent: (ref: PlacementPredecessor) => NamespaceIntent | undefined,
): PlacementVerdict {
  let verdict: PlacementVerdict = "go";
  for (const ref of intent.admission?.predecessors ?? []) {
    const predecessor = predecessorIntent(ref);
    if (!predecessor) continue;
    if (placementUnresolved(predecessor.state)) return "wait";
    if (ref.anchor && placementFailed(predecessor.state)) verdict = "repair";
  }
  return verdict;
}
