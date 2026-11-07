/**
 * The records a Copy stands on while the server has not answered: one root per selected entry,
 * made with the operation, placed by its receipt, or dropped by its refusal. A root is an ordinary
 * record (a document or a folder under a device-minted id) that holds no create of its own, so the
 * operation's answer is the only thing that moves it, and `overlayCopyRoots` shows it at the
 * destination until then.
 */
import type { CatalogFileClassification } from "@meridian/contracts/protocol";
import type {
  CopyDesired,
  CopyRoot,
  FolderNamespaceRecord,
  NamespaceIntent,
  OperationRecord,
  ResourceRecord,
  RootPlace,
} from "./resource-records";

/** The root as admission writes it: no place, no content, `uncertain` so a missed gate waits instead of writing. */
export function newCopyRootRecord(
  operation: { operationId: string; projectId: string },
  root: CopyRoot,
  scheme: string,
  classification: CatalogFileClassification | null,
): { resource: ResourceRecord } | { folder: FolderNamespaceRecord } {
  const copiedBy = { operationId: operation.operationId, projectId: operation.projectId };
  if (root.kind === "folder")
    return {
      folder: {
        // An account-owned `user` folder belongs to no project.
        projectId: scheme === "user" ? null : operation.projectId,
        handle: root.handle,
        folderId: root.copyId,
        revision: 1,
        serverHold: "uncertain",
        copiedBy,
        canonical: null,
        intents: [],
      },
    };
  if (!classification) throw new Error("A copied document needs its source's classification");
  return {
    resource: {
      resource: {
        handle: root.handle,
        revision: 1,
        identity: { documentId: root.copyId, revision: 1 },
        content: { kind: "unacquired" },
        classification,
        serverHold: "uncertain",
        copiedBy,
        canonical: null,
        lifecycle: { kind: "local" },
        aliases: {},
        obligations: {},
      },
      intents: [],
    },
  };
}

/**
 * A root given the place the receipt names. Its canonical refresh is keyed to the operation, so
 * queued moves of the copy wait for a catalog read like they do after any accepted placement.
 */
export function placeResourceRoot(
  record: ResourceRecord,
  place: RootPlace,
  operationId: string,
): ResourceRecord {
  return {
    resource: {
      ...record.resource,
      revision: record.resource.revision + 1,
      serverHold: "held",
      canonical: place.location,
      canonicalParent: place.parent,
      lifecycle: { kind: "acknowledged", availabilityGeneration: null },
      obligations: {
        ...record.resource.obligations,
        canonicalRefresh: {
          operationId,
          identityRevision: record.resource.identity.revision,
          observationVersion: place.observationVersion,
        },
      },
    },
    intents: record.intents,
  };
}

export function placeFolderRoot(
  record: FolderNamespaceRecord,
  place: RootPlace,
  operationId: string,
): FolderNamespaceRecord {
  return {
    ...record,
    revision: record.revision + 1,
    serverHold: "held",
    canonical: place.location,
    canonicalParent: place.parent,
    canonicalRefresh: { operationId, observationVersion: place.observationVersion },
  };
}

/** The copy intent of an operation that is still waiting on the server, with its roots. */
function pendingCopy(
  operation: OperationRecord,
): { intent: NamespaceIntent; copy: CopyDesired } | null {
  for (const intent of operation.intents)
    if (
      intent.desired.kind === "copy" &&
      (intent.state === "pending" || intent.state === "submitted" || intent.state === "received")
    )
      return { intent, copy: intent.desired };
  return null;
}

/**
 * The projection's arm for Copy: a root whose operation is unanswered is listed at the operation's
 * destination under its predicted name, as if it held one pending placement there. Queued work on
 * the root (a rename, a move) is newer and wins; once the receipt gives the root a place, the
 * overlay ends and the place stands. Only the projection sees it: admission and dispatch read the
 * stored records.
 */
export function overlayCopyRoots(snapshot: {
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
  operations: readonly OperationRecord[];
}): { records: readonly ResourceRecord[]; folders: readonly FolderNamespaceRecord[] } {
  const placements = new Map<string, NamespaceIntent>();
  for (const operation of snapshot.operations) {
    const pending = pendingCopy(operation);
    if (!pending) continue;
    for (const root of pending.copy.roots) {
      const destination = { ...pending.copy.destination, name: root.predictedName };
      placements.set(root.handle, {
        projectId: operation.projectId,
        handle: root.handle,
        intentId: `${pending.intent.intentId}:${root.copyId}`,
        // Before any intent the writer queues on the root, which always starts at 1.
        sequence: 0,
        ...(pending.intent.admission ? { admission: pending.intent.admission } : {}),
        identityRevision: 1,
        desired:
          root.kind === "file"
            ? { kind: "set-location", typedName: root.predictedName, destination }
            : { kind: "set-folder-location", typedName: root.predictedName, destination },
        attempts: [],
        state: pending.intent.state,
      });
    }
  }
  if (placements.size === 0) return snapshot;
  return {
    records: snapshot.records.map((record) => {
      const placement = placements.get(record.resource.handle);
      return placement ? { ...record, intents: [placement, ...record.intents] } : record;
    }),
    folders: snapshot.folders.map((folder) => {
      const placement = placements.get(folder.handle);
      return placement ? { ...folder, intents: [placement, ...folder.intents] } : folder;
    }),
  };
}
