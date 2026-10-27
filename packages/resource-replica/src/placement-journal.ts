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
  OperationRecord,
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
  kind: PlacementPredecessor["kind"];
  /** The journal's handle: a resource's or folder's, or an operation's id. */
  handle: string;
  /** The entry id the catalog and anchors name; an operation places no entry, so its own id. */
  subject: string;
  intent: NamespaceIntent & { admission: PlacementAdmission };
};

/**
 * Whether the intent still shapes the displayed list: unresolved, or accepted with the canonical
 * observation that covers it not yet installed (`refreshing` is the operation the identity's
 * refresh barrier waits on). Past that point the catalog is the truth.
 */
function shapesList(intent: NamespaceIntent, refreshing: string | undefined): boolean {
  return (
    placementUnresolved(intent.state) ||
    (intent.state === "settled" &&
      intent.operationId !== undefined &&
      intent.operationId === refreshing)
  );
}

/**
 * The admitted intents that still shape the list, in admission order. Settled history is skipped
 * before anything is allocated or sorted, so the work follows what is in flight. `operations` are
 * the operation journals the caller read (admission reads them all); the list fold passes none,
 * because it places only records until an operation's roots have a projection of their own.
 */
export function placementOps(snapshot: {
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
  operations?: readonly OperationRecord[];
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
      if (shapesList(intent, refreshing) && intent.admission)
        ops.push({ kind, handle, subject, intent: intent as PlacementOp["intent"] });
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
  if (snapshot.operations?.length) {
    // An operation's roots wait on its receipt for their canonical refresh, so it shapes the list
    // until no root's barrier names it.
    const refreshing = new Set<string>();
    for (const { resource } of snapshot.records) {
      const operationId = resource.obligations.canonicalRefresh?.operationId;
      if (operationId) refreshing.add(operationId);
    }
    for (const folder of snapshot.folders)
      if (folder.canonicalRefresh) refreshing.add(folder.canonicalRefresh.operationId);
    for (const { operationId, intents } of snapshot.operations)
      add(
        "operation",
        operationId,
        operationId,
        intents,
        refreshing.has(operationId) ? operationId : undefined,
      );
  }
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

/**
 * The conflict identity of a parent. A project's area roots exist once per project, so they are
 * qualified by it; the User area is the account's own and shared by every project, as are folder,
 * Work, lineage and chat ids, which are globally unique already.
 */
function conflictParentKey(parent: ParentRef, projectId: string): string {
  const key = placementParentKey(parent);
  return parent.kind === "root" && parent.scheme !== "user" && isProjectScopedScheme(parent.scheme)
    ? `${projectId}/${key}`
    : key;
}

export type PlacementSpec = {
  projectId: string;
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
  if (spec.source) keys.add(`parent:${conflictParentKey(spec.source, spec.projectId)}`);
  if (spec.destination) {
    keys.add(`parent:${conflictParentKey(spec.destination, spec.projectId)}`);
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
 * The spec with every id it names resolved to the identity that replaced it. A remint retires an
 * id (`aliases`), and a view that still shows it (a tab that has not caught up) must wait on the
 * replacement's journal, whose admissions are keyed by the new id.
 */
function currentSpec(
  spec: PlacementSpec,
  snapshot: { records: readonly ResourceRecord[]; folders: readonly FolderNamespaceRecord[] },
): PlacementSpec {
  const replacedBy = new Map<string, string>();
  for (const record of snapshot.records)
    for (const alias of Object.keys(record.resource.aliases))
      replacedBy.set(alias, record.resource.identity.documentId);
  for (const folder of snapshot.folders)
    for (const alias of folder.aliases ?? []) replacedBy.set(alias, folder.folderId);
  const current = (id: string) => replacedBy.get(id) ?? id;
  const { destination, position } = spec;
  return {
    ...spec,
    subject: current(spec.subject),
    destination:
      destination?.kind === "folder"
        ? { kind: "folder", folderId: current(destination.folderId) }
        : destination,
    ...(position && "siblingId" in position
      ? { position: { ...position, siblingId: current(position.siblingId) } }
      : {}),
  };
}

/**
 * The admission record for a new placement. Call it under the account's admission lock with a
 * snapshot read inside that lock: the order is one past the high-water mark, and the
 * predecessors are every unresolved intent whose scope overlaps (less those another predecessor
 * already waits on, unless this placement is anchored on them).
 */
export function capturePlacementAdmission(input: {
  /** The journals in flight; settled history is not needed (see `highWater`). */
  snapshot: {
    records: readonly ResourceRecord[];
    folders: readonly FolderNamespaceRecord[];
    operations: readonly OperationRecord[];
  };
  /** The highest admission order ever assigned, read atomically with the snapshot. */
  highWater: number;
  placement: Pick<ResourcePlacement, "parentForFolder">;
  spec: PlacementSpec;
}): PlacementAdmission {
  const spec = currentSpec(input.spec, input.snapshot);
  const scope = scopeOf(spec, input.placement.parentForFolder);
  const mine = new Set(scope);
  const anchor = anchorOf(spec.position);
  const ops = placementOps(input.snapshot);
  const overlapping = ops.filter(
    (op) =>
      placementUnresolved(op.intent.state) &&
      op.intent.admission.scope.some((key) => mine.has(key)),
  );
  const covered = new Set(
    overlapping.flatMap((op) => op.intent.admission.predecessors.map((p) => p.order)),
  );
  const predecessors: PlacementPredecessor[] = overlapping.flatMap((op) => {
    const anchored = op.subject === anchor;
    return covered.has(op.intent.admission.order) && !anchored
      ? []
      : [
          {
            kind: op.kind,
            handle: op.handle,
            order: op.intent.admission.order,
            ...(anchored ? { anchor: true as const } : {}),
          },
        ];
  });
  return {
    order: input.highWater + 1,
    scope,
    predecessors,
  };
}

export type PlacementVerdict = "go" | "wait" | "repair";

/**
 * The live intent standing for the placement admitted at `order`: the newest in the journal,
 * because a remint replaces an intent without ending the placement it carries.
 */
export function latestAdmittedPlacement(
  intents: readonly NamespaceIntent[],
  order: number,
): NamespaceIntent | undefined {
  let latest: NamespaceIntent | undefined;
  for (const intent of intents)
    if (intent.admission?.order === order && (!latest || intent.sequence > latest.sequence))
      latest = intent;
  return latest;
}

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

/** Whether a placement of the same subject was admitted after `intent` and has not been withdrawn. */
export function placementTakenSince(
  intents: readonly NamespaceIntent[],
  intent: NamespaceIntent,
): boolean {
  return intents.some(
    (later) =>
      later.sequence > intent.sequence &&
      (later.desired.kind === "set-location" || later.desired.kind === "set-folder-location") &&
      later.state !== "cancelled" &&
      later.state !== "superseded" &&
      later.state !== "unexecutable-after-terminal",
  );
}

/**
 * Whether the placement that `operationId` admitted still owns its subject, so compensating it
 * would undo the writer's own change and nobody else's. Ownership is the journal's: a newer live
 * placement of the same subject took it over. Once the canonical observation covers the accepted
 * receipt, the entry's location version must still be the one the receipt produced, which is how
 * a peer's later move shows. Until it is covered the receipt is the latest evidence there is, so
 * the operation keeps ownership; a peer move that raced the check resolves against the current
 * list on the server, like any command.
 */
export function placementStillOwned(input: {
  intents: readonly NamespaceIntent[];
  operationId: string | undefined;
  canonicalLocationVersion: string | undefined;
  canonicalObservationVersion: string | undefined;
}): boolean {
  const { intents, operationId } = input;
  if (!operationId) return false;
  const own = intents.find((intent) => intent.operationId === operationId);
  if (!own) return true;
  if (placementFailed(own.state)) return false;
  if (placementTakenSince(intents, own)) return false;
  const outcome = own.attempts.at(-1)?.outcome;
  const receipt = outcome?.kind === "operation" ? outcome.receipt : null;
  const accepted =
    receipt?.result.ok && "locationVersion" in receipt.result.value
      ? receipt.result.value.locationVersion
      : undefined;
  const covered =
    receipt &&
    input.canonicalObservationVersion !== undefined &&
    BigInt(input.canonicalObservationVersion) >= BigInt(receipt.observationVersion);
  return accepted && covered && input.canonicalLocationVersion
    ? input.canonicalLocationVersion === accepted
    : true;
}
