/** Derive immediate sibling order from durable placement intentions; ranks remain server-owned. */
import type { CatalogEntry, ContextSiblingPosition } from "@meridian/contracts/protocol";
import { indexCatalogView } from "./catalog";
import { owningLocationIntent } from "./resource-intent-policy";
import type { FolderNamespaceRecord, ResourceRecord } from "./resource-records";

type Action = {
  entryId: string;
  parentId: string;
  position?: ContextSiblingPosition;
  movedParent: boolean;
  promote: boolean;
  admissionOrder: number;
};

function activeActions(
  projectId: string,
  projected: readonly CatalogEntry[],
  canonical: ReadonlyMap<string, CatalogEntry>,
  records: readonly ResourceRecord[],
  folders: readonly FolderNamespaceRecord[],
): Action[] {
  const rows = new Map(
    projected.flatMap((entry) =>
      entry.kind === "file" || entry.kind === "folder" ? [[entry.entryId, entry] as const] : [],
    ),
  );
  const actions: Action[] = [];
  const add = (
    entryId: string,
    intent:
      | {
          admission?: { order: number };
          desired: { destination: { position?: ContextSiblingPosition } };
        }
      | undefined,
  ) => {
    const desired = intent?.desired;
    const row = rows.get(entryId);
    if (!row || !desired) return;
    const canonicalRow = canonical.get(entryId);
    const movedParent =
      !canonicalRow ||
      (canonicalRow.kind !== "file" && canonicalRow.kind !== "folder") ||
      canonicalRow.parentId !== row.parentId;
    if (!desired.destination.position && !movedParent) return;
    actions.push({
      entryId,
      parentId: row.parentId,
      ...(desired.destination.position ? { position: desired.destination.position } : {}),
      movedParent,
      promote: Boolean(desired.destination.position),
      admissionOrder: intent?.admission?.order ?? 0,
    });
  };

  for (const record of records) {
    const intent = owningLocationIntent(
      projectId,
      record.intents,
      Boolean(record.resource.obligations.canonicalRefresh),
    );
    const create = !record.resource.canonical
      ? [...record.intents]
          .reverse()
          .find(
            (candidate) =>
              candidate.projectId === projectId &&
              candidate.desired.kind === "create" &&
              candidate.desired.destination &&
              (candidate.state === "pending" ||
                candidate.state === "submitted" ||
                candidate.state === "received"),
          )
      : undefined;
    add(
      record.resource.identity.documentId,
      intent?.desired.kind === "set-location"
        ? { admission: intent.admission, desired: intent.desired }
        : create?.desired.kind === "create" && create.desired.destination
          ? {
              admission: create.admission,
              desired: { destination: create.desired.destination },
            }
          : undefined,
    );
  }
  for (const folder of folders) {
    const intent = owningLocationIntent(
      folder.projectId,
      folder.intents,
      Boolean(folder.canonicalRefresh),
    );
    add(
      folder.folderId,
      intent?.desired.kind === "set-folder-location"
        ? { admission: intent.admission, desired: intent.desired }
        : undefined,
    );
  }
  return actions.sort((left, right) => left.admissionOrder - right.admissionOrder);
}

function insertAtPosition(
  siblings: string[],
  entryId: string,
  position: ContextSiblingPosition | undefined,
): void {
  const previous = siblings.indexOf(entryId);
  if (previous >= 0) siblings.splice(previous, 1);
  if (!position || position.kind === "end") {
    siblings.push(entryId);
    return;
  }
  if (position.kind === "start") {
    siblings.unshift(entryId);
    return;
  }
  if (!("siblingId" in position)) return;
  if (position.siblingId === entryId) {
    if (previous >= 0) siblings.splice(previous, 0, entryId);
    return;
  }
  const anchor = siblings.indexOf(position.siblingId);
  if (anchor < 0) {
    if (previous >= 0) siblings.splice(Math.min(previous, siblings.length), 0, entryId);
    return;
  }
  siblings.splice(position.kind === "before" ? anchor : anchor + 1, 0, entryId);
}

/**
 * A positional command promotes its destination in the projection and derives a complete local
 * order from the journaled intent. Synthetic ranks never leave this projection or enter a request.
 */
export function projectOptimisticSiblingOrder(input: {
  projectId: string;
  canonical: readonly CatalogEntry[];
  projected: readonly CatalogEntry[];
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
}): readonly CatalogEntry[] {
  const canonical = new Map(input.canonical.map((entry) => [entry.entryId, entry]));
  const actions = activeActions(
    input.projectId,
    input.projected,
    canonical,
    input.records,
    input.folders,
  );
  if (actions.length === 0) return input.projected;

  const entries = new Map(input.projected.map((entry) => [entry.entryId, entry]));
  const indexed = indexCatalogView({
    scope: { kind: "project", projectId: input.projectId },
    generation: "",
    appliedRevision: "0",
    observedHeadRevision: "0",
    cursor: "",
    entries,
  });
  const byParent = new Map(
    [...indexed.childIdsByParentId].map(([parentId, ids]) => [parentId, [...ids]]),
  );
  const affected = new Set<string>();
  for (const action of actions) {
    const parent = entries.get(action.parentId);
    const manual =
      (parent?.kind === "source" || parent?.kind === "folder") && parent.orderPolicy === "manual";
    if (!action.position && !(action.movedParent && manual)) continue;
    const siblings = byParent.get(action.parentId) ?? [];
    insertAtPosition(siblings, action.entryId, action.position);
    byParent.set(action.parentId, siblings);
    affected.add(action.parentId);
    if (action.promote) {
      const parent = entries.get(action.parentId);
      if (parent?.kind === "source" || parent?.kind === "folder")
        entries.set(action.parentId, { ...parent, orderPolicy: "manual" });
    }
  }
  for (const parentId of affected) {
    const siblings = byParent.get(parentId) ?? [];
    siblings.forEach((entryId, index) => {
      const entry = entries.get(entryId);
      if (entry?.kind !== "file" && entry?.kind !== "folder") return;
      entries.set(entryId, { ...entry, rank: `local:${String(index).padStart(12, "0")}` });
    });
  }
  return [...entries.values()];
}
