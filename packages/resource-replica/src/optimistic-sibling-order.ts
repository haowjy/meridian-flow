/**
 * The displayed sibling order while placements are unresolved: one fold of the placement journal
 * over canonical state. Ranks stay server-owned; the synthetic ones made here never leave the
 * projection.
 */
import type { CatalogEntry, ContextSiblingPosition } from "@meridian/contracts/protocol";
import { placementOps } from "./placement-journal";
import type { FolderNamespaceRecord, ParentRef, ResourceRecord } from "./resource-records";
import { ownerListedInScope } from "./resource-work-authority";
import { compareCatalogSiblings, compareDefaultSiblings, isManualParent } from "./sibling-order";

type Child = Extract<CatalogEntry, { kind: "file" | "folder" }>;
type Source = Extract<CatalogEntry, { kind: "source" }>;

const isChild = (entry: CatalogEntry | undefined): entry is Child =>
  entry?.kind === "file" || entry?.kind === "folder";

/** Put `entryId` where `position` says, or back where it was when the position cannot be honoured. */
function insertAtPosition(
  siblings: string[],
  entryId: string,
  position: ContextSiblingPosition,
  previousIndex: number,
): void {
  if (position.kind === "end") {
    siblings.push(entryId);
    return;
  }
  if (position.kind === "start") {
    siblings.unshift(entryId);
    return;
  }
  const anchor = "siblingId" in position ? siblings.indexOf(position.siblingId) : -1;
  if (anchor < 0) {
    // The anchor is gone from this list; the server will refuse, so the row keeps its place.
    siblings.splice(
      previousIndex >= 0 ? Math.min(previousIndex, siblings.length) : siblings.length,
      0,
      entryId,
    );
    return;
  }
  siblings.splice(position.kind === "before" ? anchor : anchor + 1, 0, entryId);
}

/**
 * Fold every unresolved placement, in admission order, over the canonical sibling lists:
 * membership, parent-policy promotion and position change together, step by step. A move
 * into a default parent that carries a position promotes it first; an arrival without one lands
 * last in a manual parent and in name order in a default one. The projected rows say where each
 * subject finally stands (its last placement); earlier steps resolve their destination from the
 * placement itself.
 */
export function projectOptimisticSiblingOrder(input: {
  projectId: string;
  canonical: readonly CatalogEntry[];
  projected: readonly CatalogEntry[];
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
}): readonly CatalogEntry[] {
  const { projectId } = input;
  const entries = new Map(input.projected.map((entry) => [entry.entryId, entry]));
  const ops = placementOps(input).filter(
    (op) =>
      op.intent.projectId === projectId &&
      entries.has(op.subject) &&
      (op.intent.desired.kind === "set-location" ||
        op.intent.desired.kind === "set-folder-location" ||
        (op.intent.desired.kind === "create" && op.intent.desired.destination)),
  );
  if (ops.length === 0) return input.projected;

  const canonical = new Map(input.canonical.map((entry) => [entry.entryId, entry]));
  const touched = new Set(ops.map((op) => op.subject));
  const lastOp = new Map(ops.map((op) => [op.subject, op.intent.intentId]));
  const sources = input.projected.filter((entry): entry is Source => entry.kind === "source");
  const destinationId = (parent: ParentRef): string | undefined =>
    parent.kind === "folder"
      ? parent.folderId
      : sources.find(
          (source) =>
            source.scheme === parent.scheme &&
            ownerListedInScope(parent.owner, parent.scheme, source.scope, projectId),
        )?.entryId;

  // Baseline: where each row stood before any unresolved placement touched it.
  const seq = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const entry of entries.values()) {
    if (!isChild(entry)) continue;
    const base = touched.has(entry.entryId) ? canonical.get(entry.entryId) : entry;
    if (!isChild(base)) continue;
    parentOf.set(entry.entryId, base.parentId);
    const siblings = seq.get(base.parentId);
    if (siblings) siblings.push(entry.entryId);
    else seq.set(base.parentId, [entry.entryId]);
  }
  const manual = new Set<string>();
  for (const [parentId, ids] of seq) {
    if (isManualParent(entries.get(parentId))) manual.add(parentId);
    const useRank = manual.has(parentId);
    ids.sort((leftId, rightId) => {
      const left = entries.get(leftId);
      const right = entries.get(rightId);
      return isChild(left) && isChild(right) ? compareCatalogSiblings(useRank, left, right) : 0;
    });
  }
  const byName = (leftId: string, rightId: string) => {
    const left = entries.get(leftId);
    const right = entries.get(rightId);
    return isChild(left) && isChild(right)
      ? compareDefaultSiblings(
          { kind: left.kind, name: left.name, identity: left.entryId },
          { kind: right.kind, name: right.name, identity: right.entryId },
        )
      : 0;
  };

  const affected = new Set<string>();
  for (const op of ops) {
    const subject = entries.get(op.subject);
    if (!isChild(subject)) continue;
    const { destination } = op.intent.desired as {
      destination: { parent: ParentRef; position?: ContextSiblingPosition };
    };
    const target =
      lastOp.get(op.subject) === op.intent.intentId
        ? subject.parentId
        : (destinationId(destination.parent) ?? subject.parentId);
    const from = parentOf.get(op.subject);
    const position = destination.position;
    if (!position && from === target) continue;
    const previousIndex = from ? (seq.get(from)?.indexOf(op.subject) ?? -1) : -1;
    if (from) {
      const siblings = seq.get(from);
      if (siblings && previousIndex >= 0) siblings.splice(previousIndex, 1);
      affected.add(from);
    }
    const siblings = seq.get(target) ?? [];
    seq.set(target, siblings);
    if (position) {
      manual.add(target);
      insertAtPosition(siblings, op.subject, position, from === target ? previousIndex : -1);
    } else {
      siblings.push(op.subject);
      if (!manual.has(target)) siblings.sort(byName);
    }
    parentOf.set(op.subject, target);
    affected.add(target);
  }

  for (const parentId of affected) {
    if (!manual.has(parentId)) continue;
    const parent = entries.get(parentId);
    if (parent?.kind === "source" || parent?.kind === "folder")
      entries.set(parentId, { ...parent, orderPolicy: "manual" });
    seq.get(parentId)?.forEach((entryId, index) => {
      const entry = entries.get(entryId);
      if (isChild(entry))
        entries.set(entryId, { ...entry, rank: `local:${String(index).padStart(12, "0")}` });
    });
  }
  return [...entries.values()];
}
