/** Folder placement and recursive deletion share the account namespace journal, without document content. */

import type {
  ContextOperationReceipt,
  ContextParentOrderPolicy,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { canonicalRefreshObservation, newerCanonicalObservation } from "./canonical-observation";
import {
  namespaceIntentOutcome,
  namespaceRepairDestination,
  neverAccepted,
  resolveUnavailableNamespace,
  settleNamespaceIntent,
  validateNamespaceJournal,
} from "./namespace-journal-policy";
import { committedResourceDeletion, LOCAL_DELETION_UNDO_MS } from "./resource-deletion";
import {
  intentOwnsDeletionAt,
  owningLocationIntent,
  supersedeRepairableNamespaceWork,
} from "./resource-intent-policy";
import {
  activeNamespaceIntent,
  createDestination,
  displayedPath,
  type NamespaceAttemptIds,
  type NamespaceGate,
  type NamespaceReconcileResult,
  namespaceAttemptWithOutcome,
  namespaceOutcomeMatches,
  namespaceReceiptIs,
  reconcileNamespaceJournal,
} from "./resource-namespace";
import type {
  DestinationParentLookup,
  FolderNamespaceRecord,
  FolderNamespaceWrite,
  MetadataCommitResult,
  NamespaceIdentityAvailability,
  NamespaceIntent,
  NamespaceOutcome,
  NamespaceRequest,
  ParentRef,
  PlacementAdmission,
  ResourceDestination,
  ResourceKey,
  ResourceLocation,
  ResourceNamespaceLock,
  ResourceNamespaceTransport,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";
import {
  destinationLocation,
  destinationParentLocation,
  ownerOf,
  sameOwner,
} from "./resource-records";
import { moveOwnerFields, resourceContextAuthority } from "./resource-work-authority";

/** Browser persistence implements this alongside its file journal, in the same account owner. */
export interface FolderNamespaceStore {
  readonly accountId: string;
  readFolder(key: ResourceKey): Promise<FolderNamespaceRecord | null>;
  readFolders(projectId: string): Promise<readonly FolderNamespaceRecord[]>;
  commitFolder(write: FolderNamespaceWrite): Promise<MetadataCommitResult>;
}

function pathParts(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Where the folder stands with no placement over it: its canonical place, else (a local folder
 * whose create was refused) Unfiled at the name last typed, as a refused document is listed.
 */
export function folderBaseLocation(
  record: Pick<FolderNamespaceRecord, "canonical" | "intents">,
): ResourceLocation {
  if (record.canonical) return record.canonical;
  const placed = record.intents.filter((intent) => intent.desired.kind === "set-folder-location");
  const newest = placed.reduce((a, b) => (b.sequence > a.sequence ? b : a));
  const name = newest.desired.kind === "set-folder-location" ? newest.desired.typedName : "";
  return { scheme: "unfiled", path: `/${name}`, name, workId: null };
}

export function projectFolderNeedsRepair(record: FolderNamespaceRecord): {
  intentId: string;
  /** `create`: the server refused the folder's first placement, so it exists only here. */
  kind: "delete" | "set-location" | "create";
  name: string;
  destination?: ResourceDestination;
} | null {
  const failed = record.intents.find((intent) => intent.state === "needs-repair");
  if (failed?.desired.kind === "delete")
    return { intentId: failed.intentId, kind: "delete", name: folderBaseLocation(record).name };
  if (failed?.desired.kind !== "set-folder-location") return null;
  const destination = namespaceRepairDestination(record.intents, failed);
  return destination
    ? {
        intentId: failed.intentId,
        kind: record.canonical ? "set-location" : "create",
        name: destination.name,
        destination,
      }
    : null;
}

/**
 * Whether the folder has a row of its own beside the catalog's: one in repair, or one created
 * here that no catalog read has observed yet (local, or accepted and not yet listed).
 */
export function folderListedLocally(record: FolderNamespaceRecord): boolean {
  return (
    projectFolderNeedsRepair(record) !== null ||
    record.canonical === null ||
    (record.observationVersion === undefined &&
      record.intents.some((intent) =>
        intent.attempts.some((attempt) => attempt.request.kind === "create-folder"),
      ))
  );
}

/** Work that can progress without a new writer command, as `resourceNeedsBackgroundReconciliation` for files. */
export function folderNeedsBackgroundReconciliation(record: FolderNamespaceRecord): boolean {
  return record.intents.some(
    (intent) =>
      intent.state === "pending" || intent.state === "submitted" || intent.state === "received",
  );
}

export function projectFolderLocation(
  record: FolderNamespaceRecord,
  lookup: DestinationParentLookup = () => null,
): ResourceLocation {
  const desired = owningLocationIntent(
    record.projectId,
    record.intents,
    Boolean(record.canonicalRefresh),
  )?.desired;
  return desired?.kind === "set-folder-location"
    ? (destinationLocation(desired.destination, lookup) ?? folderBaseLocation(record))
    : folderBaseLocation(record);
}

/** A newer present observation clears `terminal` and retires an accepted delete's ownership. */
export function folderOwnsDeletion(record: FolderNamespaceRecord): boolean {
  return (
    Boolean(record.terminal) ||
    record.intents.some((intent) => intentOwnsDeletionAt(intent, record.observationVersion))
  );
}

/** The journal record a command lands on: the one held, else a catalog observation's. */
function folderRecordFor(input: {
  record?: FolderNamespaceRecord | null;
  projectId: string;
  handle: string;
  folderId: string;
  /** The installed catalog's location; required when the journal holds no record yet. */
  source?: ResourceLocation;
  sourceParent?: ParentRef;
  sourceObservationVersion?: string;
}): FolderNamespaceRecord {
  const previous = input.record ?? null;
  if (
    previous &&
    ((previous.projectId !== null && previous.projectId !== input.projectId) ||
      previous.handle !== input.handle ||
      previous.folderId !== input.folderId)
  )
    throw new Error("Folder namespace identity mismatch");
  if (previous) return previous;
  if (!input.source) throw new Error("Folder is unavailable");
  return {
    projectId: input.source.scheme === "user" ? null : input.projectId,
    handle: input.handle,
    folderId: input.folderId,
    revision: 0,
    canonical: input.source,
    canonicalParent: input.sourceParent,
    observationVersion: input.sourceObservationVersion,
    intents: [],
  };
}

/** Recursive deletion is namespace work; its receipt settles descendants atomically. */
export function planFolderDeletion(input: {
  record?: FolderNamespaceRecord | null;
  projectId: string;
  handle: string;
  folderId: string;
  source?: ResourceLocation;
  sourceParent?: ParentRef;
  sourceObservationVersion?: string;
  intentId: string;
  operationId: string;
  admission?: PlacementAdmission;
  now?: number;
}): FolderNamespaceWrite | null {
  const record = folderRecordFor(input);
  if (folderOwnsDeletion(record)) return null;
  if (record.canonical) resourceContextAuthority(record.canonical.scheme, record.canonical);
  // A folder the server never accepted has nothing to delete there: deleting it is local, and
  // the writer keeps the same Undo window a server deletion has.
  const localDeletion = neverAccepted(record);
  const now = input.now ?? Date.now();
  const superseded = supersedeRepairableNamespaceWork(record, record.projectId);
  return {
    expectedRevision: input.record?.revision ?? null,
    next: {
      ...record,
      revision: record.revision + 1,
      ...(localDeletion
        ? {
            localDeletion: {
              obligationId: input.intentId,
              notBefore: now + LOCAL_DELETION_UNDO_MS,
            },
          }
        : {}),
      intents: [
        ...superseded.intents.map((intent) =>
          intent.state === "pending" && !intent.attempts.length
            ? { ...intent, state: "cancelled" as const }
            : intent,
        ),
        {
          projectId: input.projectId,
          handle: input.handle,
          intentId: input.intentId,
          operationId: input.operationId,
          sequence: Math.max(0, ...record.intents.map((intent) => intent.sequence)) + 1,
          identityRevision: 1,
          desired: { kind: "delete" },
          ...(input.admission ? { admission: input.admission } : {}),
          attempts: [],
          state: localDeletion ? "settled-locally" : "pending",
        },
      ],
    },
  };
}

/**
 * Undo of a folder deletion that settled on this device inside its window: the deletion is
 * superseded and the folder's last placement is queued again, with the children it kept. Null
 * once the window has closed or when no such deletion is held.
 */
export function planFolderLocalDeletionUndo(
  record: FolderNamespaceRecord,
  input: { operationId: string; createIntentId: string; now: number },
): FolderNamespaceWrite | null {
  const deletion = record.intents.find(
    (intent) =>
      intent.operationId === input.operationId &&
      intent.desired.kind === "delete" &&
      intent.state === "settled-locally",
  );
  const window = record.localDeletion;
  if (!deletion || window?.obligationId !== deletion.intentId || input.now >= window.notBefore)
    return null;
  const create = record.intents
    .filter((intent) => intent.desired.kind === "set-folder-location")
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (!create) return null;
  const { localDeletion: _closed, ...withoutWindow } = record;
  return {
    expectedRevision: record.revision,
    next: {
      ...withoutWindow,
      revision: record.revision + 1,
      intents: [
        ...record.intents.map((intent) =>
          intent === deletion ? { ...intent, state: "superseded" as const } : intent,
        ),
        {
          projectId: create.projectId,
          handle: record.handle,
          intentId: input.createIntentId,
          sequence: Math.max(...record.intents.map((intent) => intent.sequence)) + 1,
          identityRevision: 1,
          desired: create.desired,
          ...(create.admission ? { admission: create.admission } : {}),
          attempts: [],
          state: "pending",
        },
      ],
    },
  };
}

function checkFolderName(name: string): void {
  if (!name || name.includes("/") || [".", ".."].includes(name))
    throw new Error("Invalid folder name");
}

/** The folder's next placement; its request is a create while the server holds no such folder. */
function placementIntent(
  record: Pick<FolderNamespaceRecord, "handle" | "intents">,
  input: {
    projectId: string;
    intentId: string;
    /** Absent for a create: it is replayed under the folder id, and nothing compensates it. */
    operationId?: string;
    admission?: PlacementAdmission;
    destination: ResourceDestination;
    typedName?: string;
  },
): NamespaceIntent {
  return {
    handle: record.handle,
    projectId: input.projectId,
    intentId: input.intentId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    sequence: Math.max(0, ...record.intents.map((item) => item.sequence)) + 1,
    ...(input.admission ? { admission: input.admission } : {}),
    identityRevision: 1,
    desired: {
      kind: "set-folder-location",
      typedName: input.typedName ?? input.destination.name,
      destination: input.destination,
    },
    attempts: [],
    state: "pending",
  };
}

/**
 * A folder only this device holds yet: a local record whose first placement is its create. The
 * id is the writer's to name from now on, so a document or folder can be placed in it, and
 * deleted with it, before the server has answered. It reserves namespace identity only, never a
 * Yjs database or document id.
 */
export function planFolderCreate(input: {
  projectId: string;
  /** The destination's scheme: an account-owned `user` folder belongs to no project. */
  scheme: ProjectContextTreeScheme;
  handle: string;
  folderId: string;
  intentId: string;
  admission?: PlacementAdmission;
  destination: ResourceDestination;
}): FolderNamespaceWrite {
  checkFolderName(input.destination.name);
  const record: FolderNamespaceRecord = {
    projectId: input.scheme === "user" ? null : input.projectId,
    handle: input.handle,
    folderId: input.folderId,
    revision: 1,
    canonical: null,
    intents: [],
  };
  return { expectedRevision: null, next: { ...record, intents: [placementIntent(record, input)] } };
}

/** Folder records reserve only namespace identity, never a Yjs database or document id. */
export function planFolderLocation(input: {
  record?: FolderNamespaceRecord | null;
  projectId: string;
  handle: string;
  folderId: string;
  source?: ResourceLocation;
  sourceParent?: ParentRef;
  sourceObservationVersion?: string;
  intentId: string;
  operationId: string;
  admission?: PlacementAdmission;
  destination: ResourceDestination;
  typedName?: string;
}): FolderNamespaceWrite | null {
  if (input.record && folderOwnsDeletion(input.record)) throw new Error("Folder is being deleted");
  const record = folderRecordFor(input);
  if (record.canonical) resourceContextAuthority(record.canonical.scheme, record.canonical);
  checkFolderName(input.destination.name);
  const superseded = supersedeRepairableNamespaceWork(
    { intents: record.intents },
    record.projectId,
  );
  if (
    input.destination.parent.kind === "folder" &&
    input.destination.parent.folderId === input.folderId
  )
    throw new Error("Cannot move a folder inside itself");
  const destination = destinationLocation(input.destination, () => null);
  if (
    record.canonical &&
    destination &&
    destination.scheme === record.canonical.scheme &&
    sameOwner(destination, record.canonical) &&
    destination.path === record.canonical.path &&
    !input.destination.position &&
    !superseded.repaired
  )
    return null;
  return {
    expectedRevision: input.record?.revision ?? null,
    next: {
      ...record,
      revision: record.revision + 1,
      intents: [...superseded.intents, placementIntent(record, input)],
    },
  };
}

export function validateFolderNamespaceUpdate(
  previous: FolderNamespaceRecord | null,
  next: FolderNamespaceRecord,
): void {
  if (next.revision !== (previous?.revision ?? 0) + 1)
    throw new Error("Invalid folder namespace revision");
  if (
    previous &&
    (next.handle !== previous.handle ||
      next.folderId !== previous.folderId ||
      next.projectId !== previous.projectId)
  )
    throw new Error("Folder namespace identity mismatch");
  if (
    next.intents.some(
      (intent) =>
        (next.projectId !== null && intent.projectId !== next.projectId) ||
        intent.identityRevision !== 1 ||
        (intent.desired.kind !== "set-folder-location" && intent.desired.kind !== "delete"),
    )
  )
    throw new Error("Folder journal only admits folder namespace commands");
  if (
    next.intents.some((intent) =>
      intent.attempts.some(({ request }) =>
        request.kind === "create"
          ? true
          : request.kind === "create-folder"
            ? request.body.folderId !== next.folderId
            : request.body.expected.kind !== "folder" ||
              request.body.expected.nodeId !== next.folderId,
      ),
    )
  )
    throw new Error("Folder journal request identity mismatch");
  if (
    previous?.canonicalRefresh &&
    next.canonicalRefresh &&
    previous.canonicalRefresh.operationId !== next.canonicalRefresh.operationId
  )
    throw new Error("Folder canonical refresh cannot be replaced");
  if (previous?.terminal && JSON.stringify(previous.terminal) !== JSON.stringify(next.terminal)) {
    // Only a strictly newer server observation of the folder as present supersedes deletion.
    const restored =
      !next.terminal &&
      next.observationVersion !== undefined &&
      newerCanonicalObservation(next.observationVersion, previous.observationVersion);
    if (!restored) throw new Error("Terminal folders revive only from newer server observations");
  }
  validateNamespaceJournal({
    previous,
    next,
    identityRevision: 1,
    terminal: Boolean(next.terminal),
    localDeletionAllowed: neverAccepted(next),
    // Undo of a local folder deletion clears its window; that deletion may become superseded.
    revokedLocalDeletions: new Set(
      previous?.intents
        .filter(
          (intent) =>
            intent.state === "settled-locally" &&
            previous.localDeletion?.obligationId === intent.intentId &&
            next.localDeletion?.obligationId !== intent.intentId,
        )
        .map((intent) => intent.intentId),
    ),
  });
  if (
    next.localDeletion &&
    !next.intents.some(
      (intent) =>
        intent.intentId === next.localDeletion?.obligationId &&
        intent.desired.kind === "delete" &&
        intent.state === "settled-locally",
    )
  )
    throw new Error("A local deletion window names its settled delete");
  if (
    !next.localDeletion &&
    next.intents.some(
      (intent) => intent.desired.kind === "delete" && intent.state === "settled-locally",
    )
  )
    throw new Error("A settled local deletion keeps its Undo window");
  if (next.canonical) resourceContextAuthority(next.canonical.scheme, next.canonical);
  else if (
    next.canonicalParent ||
    next.observationVersion !== undefined ||
    next.canonicalRefresh ||
    next.terminal ||
    !next.intents.some((intent) => intent.desired.kind === "set-folder-location")
  )
    throw new Error("A local folder holds its create and no server observation");
  // A folder the server holds has a place; it gains one only from its accepted create.
  if (previous?.canonical && !next.canonical)
    throw new Error("A folder cannot lose its canonical place");
  if (
    previous &&
    !previous.canonical &&
    next.canonical &&
    !next.intents.some((intent) => intent.attempts.some((a) => a.outcome?.kind === "create-folder"))
  )
    throw new Error("A local folder gains a place only from its accepted create");
  if (
    next.canonicalRefresh &&
    !next.intents.some((intent) =>
      intent.attempts.some(
        (attempt) =>
          attempt.outcome?.kind === "operation" &&
          attempt.outcome.receipt.operationId === next.canonicalRefresh?.operationId &&
          attempt.outcome.receipt.command.kind === "move" &&
          attempt.outcome.receipt.result.ok,
      ),
    )
  )
    throw new Error("Folder refresh requires a successful move receipt");
}

function replaceIntent(
  record: FolderNamespaceRecord,
  intentId: string,
  replace: (intent: NamespaceIntent) => NamespaceIntent,
): FolderNamespaceWrite {
  return {
    expectedRevision: record.revision,
    next: {
      ...record,
      revision: record.revision + 1,
      intents: record.intents.map((intent) =>
        intent.intentId === intentId ? replace(intent) : intent,
      ),
    },
  };
}

export function prepareFolderNamespaceAttempt(
  record: FolderNamespaceRecord,
  ids: NamespaceAttemptIds,
  lookup: DestinationParentLookup = () => null,
): FolderNamespaceWrite | null {
  const intent = activeNamespaceIntent(record);
  if (
    intent?.state !== "pending" ||
    (intent.desired.kind !== "set-folder-location" && intent.desired.kind !== "delete") ||
    (record.canonicalRefresh && !record.terminal)
  )
    return null;
  if (record.terminal)
    return {
      expectedRevision: record.revision,
      next: {
        ...record,
        revision: record.revision + 1,
        intents: resolveUnavailableNamespace(record.intents, true),
      },
    };
  const source = record.canonical;
  if (intent.desired.kind === "delete") {
    // A delete queued behind a refused create has nothing on the server to delete.
    if (!source)
      return replaceIntent(record, intent.intentId, (current) => ({
        ...current,
        state: "settled-locally",
      }));
    const request: Extract<NamespaceRequest, { kind: "delete" }> = {
      kind: "delete",
      scheme: source.scheme,
      workId: source.workId,
      workHandle: source.workHandle ?? null,
      rootThreadId: source.rootThreadId ?? null,
      rootThreadRef: source.rootThreadRef ?? null,
      body: {
        operationId: intent.operationId ?? ids.operationId,
        path: pathParts(source.path).join("/"),
        expected: { kind: "folder", nodeId: record.folderId },
      },
    };
    return replaceIntent(record, intent.intentId, (current) => ({
      ...current,
      state: "submitted",
      attempts: [...current.attempts, { attemptId: ids.attemptId, request }],
    }));
  }
  const destination = intent.desired.destination;
  const parent = destinationParentLocation(destination.parent, lookup);
  if (!parent)
    return replaceIntent(record, intent.intentId, (current) => ({
      ...current,
      state: "needs-repair",
    }));
  if (!source) {
    const request: Extract<NamespaceRequest, { kind: "create-folder" }> = {
      kind: "create-folder",
      owner: ownerOf(parent),
      body: { folderId: record.folderId, destination: createDestination(destination) },
    };
    return replaceIntent(record, intent.intentId, (current) => ({
      ...current,
      state: "submitted",
      attempts: [...current.attempts, { attemptId: ids.attemptId, request }],
    }));
  }
  const owners = moveOwnerFields(source, parent);
  const request: Extract<NamespaceRequest, { kind: "move" }> = {
    kind: "move",
    scheme: source.scheme,
    ...owners,
    body: {
      operationId: intent.operationId ?? ids.operationId,
      path: pathParts(source.path).join("/"),
      expected: { kind: "folder", nodeId: record.folderId },
      destinationParent: {
        ...destination.parent,
        ...(destination.createFolders?.length ? { createFolders: destination.createFolders } : {}),
      },
      destinationScheme: parent.scheme,
      destinationFolderPath: [...pathParts(parent.path), ...(destination.createFolders ?? [])].join(
        "/",
      ),
      ...owners.body,
      ...(intent.desired.typedName !== source.name ? { newName: intent.desired.typedName } : {}),
      ...(destination.position ? { position: destination.position } : {}),
    },
  };
  return replaceIntent(record, intent.intentId, (current) => ({
    ...current,
    state: "submitted",
    attempts: [...current.attempts, { attemptId: ids.attemptId, request }],
  }));
}

export function recordFolderNamespaceOutcome(
  record: FolderNamespaceRecord,
  intentId: string,
  attemptId: string,
  outcome: NamespaceOutcome,
): FolderNamespaceWrite | null {
  const intent = record.intents.find((candidate) => candidate.intentId === intentId);
  const attempt = intent?.attempts.at(-1);
  if (!intent || !attempt || attempt.attemptId !== attemptId)
    throw new Error("Namespace attempt is no longer current");
  if (attempt.outcome) return null;
  if (intent.state !== "submitted" || !namespaceOutcomeMatches(attempt, outcome))
    throw new Error("Namespace outcome does not match current attempt");
  return replaceIntent(record, intentId, (current) => ({
    ...current,
    state: "received",
    attempts: current.attempts.map((candidate) =>
      candidate.attemptId === attemptId
        ? namespaceAttemptWithOutcome(candidate, outcome)
        : candidate,
    ),
  }));
}

export function settleFolderNamespaceOutcome(
  record: FolderNamespaceRecord,
  settledAt = Date.now(),
): FolderNamespaceWrite | null {
  const intent = activeNamespaceIntent(record);
  const outcome = intent?.attempts.at(-1)?.outcome;
  if (
    intent?.state !== "received" ||
    !outcome ||
    outcome.kind === "create" ||
    (outcome.kind === "operation" &&
      outcome.receipt.command.kind !== "move" &&
      outcome.receipt.command.kind !== "delete")
  )
    return null;
  const disposition = namespaceIntentOutcome(outcome, Boolean(record.terminal));
  const write: FolderNamespaceWrite = {
    expectedRevision: record.revision,
    next: {
      ...record,
      revision: record.revision + 1,
      intents: settleNamespaceIntent(record.intents, intent, disposition, settledAt),
    },
  };
  if (disposition !== "accepted") return write;
  if (outcome.kind === "operation" && outcome.receipt.command.kind === "move")
    write.next.canonicalRefresh = {
      operationId: outcome.receipt.operationId,
      observationVersion: outcome.receipt.observationVersion,
    };
  // The answer is the folder's first place; the catalog's observation replaces it with parent,
  // rank and freshness once it lists the folder.
  const request = intent.attempts.at(-1)?.request;
  if (
    outcome.kind === "create-folder" &&
    outcome.result.status !== "conflict" &&
    request?.kind === "create-folder"
  )
    write.next.canonical = {
      scheme: outcome.result.scheme,
      path: displayedPath(outcome.result.path),
      name: outcome.result.name,
      ...request.owner,
    };
  return write;
}

/** Called within the folder settlement's metadata transaction, against current exact identities. */
export function folderDeletionSettlement(
  previous: FolderNamespaceRecord | null,
  next: FolderNamespaceRecord,
): Extract<ContextOperationReceipt, { command: { kind: "delete" } }> | null {
  const deletion = next.intents.find(
    (intent) =>
      intent.desired.kind === "delete" &&
      intent.state === "settled" &&
      previous?.intents.find((old) => old.intentId === intent.intentId)?.state !== "settled",
  );
  const outcome = deletion?.attempts.at(-1)?.outcome;
  if (
    outcome?.kind !== "operation" ||
    !namespaceReceiptIs(outcome.receipt, "delete") ||
    !outcome.receipt.result.ok
  )
    return null;
  return outcome.receipt;
}

/** Exact IDs and newer catalog generations fence historical recursive-delete receipts. */
export function planFolderDeletionResources(
  receipt: Extract<ContextOperationReceipt, { command: { kind: "delete" } }>,
  resources: readonly ResourceRecord[],
): ResourceWrite[] {
  if (!receipt.result.ok) return [];
  const result = receipt.result.value;
  const ids = new Set(result.removed.map(({ documentId }) => documentId));
  return resources.flatMap((record): ResourceWrite[] => {
    const resource = record.resource;
    if (
      !ids.has(resource.identity.documentId) ||
      resource.lifecycle.kind === "terminal" ||
      (resource.lifecycle.kind === "acknowledged" &&
        resource.lifecycle.availabilityGeneration !== null &&
        BigInt(resource.lifecycle.availabilityGeneration) > BigInt(result.availabilityGeneration))
    )
      return [];
    return [
      {
        expectedRevision: resource.revision,
        next: {
          ...record,
          resource: {
            ...committedResourceDeletion(
              resource,
              result.availabilityGeneration,
              receipt.operationId,
              receipt.observationVersion,
            ),
            revision: resource.revision + 1,
          },
        },
      },
    ];
  });
}

/** Only a catalog observation captured after settlement may clear the replay barrier. */
export function installFolderCanonicalRefresh(
  record: FolderNamespaceRecord,
  operationId: string,
  location: ResourceLocation,
  parent: ParentRef,
  observationVersion: string,
  rank?: string | null,
  orderPolicy?: ContextParentOrderPolicy,
  locationVersion?: string,
): FolderNamespaceWrite | null {
  if (record.canonicalRefresh?.operationId !== operationId) return null;
  const { newer, completes } = canonicalRefreshObservation(
    observationVersion,
    record.observationVersion,
    record.canonicalRefresh.observationVersion,
  );
  if (!newer && !completes) return null;
  resourceContextAuthority(location.scheme, location);
  const { canonicalRefresh: _completed, ...withoutRefresh } = record;
  const base = completes ? withoutRefresh : record;
  // A strictly newer observation of the folder as present supersedes a terminal witness.
  const { terminal: _superseded, ...present } = base;
  return {
    expectedRevision: record.revision,
    next: {
      ...(newer ? present : base),
      revision: record.revision + 1,
      ...(newer
        ? {
            canonical: location,
            canonicalParent: parent,
            canonicalRank: rank,
            canonicalLocationVersion: locationVersion,
            canonicalOrderPolicy: orderPolicy,
            observationVersion,
          }
        : {}),
    },
  };
}

/** A scoped disappearance asks exact-ID availability; it never terminalizes descendant content. */
export function installFolderNamespaceAvailability(
  record: FolderNamespaceRecord,
  operationId: string,
  availability: NamespaceIdentityAvailability,
): FolderNamespaceWrite | null {
  if (record.canonicalRefresh?.operationId !== operationId) return null;
  if (availability.kind === "available")
    return installFolderCanonicalRefresh(
      record,
      operationId,
      availability.location,
      availability.parent,
      availability.observationVersion,
      availability.rank,
      availability.orderPolicy,
      availability.locationVersion,
    );
  const { canonicalRefresh: _completed, ...rest } = record;
  if (
    availability.kind === "deleted" &&
    !newerCanonicalObservation(availability.observationVersion, record.observationVersion)
  )
    return null;
  const terminal =
    availability.kind === "deleted" ? { generation: availability.generation } : record.terminal;
  return {
    expectedRevision: record.revision,
    next: {
      ...rest,
      revision: record.revision + 1,
      ...(terminal ? { terminal } : {}),
      ...(availability.kind === "deleted"
        ? { observationVersion: availability.observationVersion }
        : {}),
      intents: resolveUnavailableNamespace(record.intents, Boolean(terminal)),
    },
  };
}

export function reconcileFolderNamespace(input: {
  key: ResourceKey;
  metadata: FolderNamespaceStore;
  transport: ResourceNamespaceTransport;
  lock: ResourceNamespaceLock;
  newAttemptIds: () => NamespaceAttemptIds;
  gate?: NamespaceGate;
  now?: () => number;
}): Promise<NamespaceReconcileResult> {
  return reconcileNamespaceJournal({
    ...input,
    read: () => input.metadata.readFolder(input.key),
    commit: (write: FolderNamespaceWrite) => input.metadata.commitFolder(write),
    refresh: async (record) => {
      const barrier = record.canonicalRefresh;
      if (!barrier) return null;
      const intent = record.intents.find((i) =>
        i.attempts.some(
          (a) =>
            (a.request.kind === "move" || a.request.kind === "delete") &&
            a.request.body.operationId === barrier.operationId,
        ),
      );
      if (!intent) return null;
      return installFolderNamespaceAvailability(
        record,
        barrier.operationId,
        await input.transport.lookupIdentity(intent.projectId, {
          kind: "folder",
          id: record.folderId,
        }),
      );
    },
    prepare: async (record, ids) => {
      const intent = activeNamespaceIntent(record);
      const parent =
        intent?.desired.kind === "set-folder-location" ? intent.desired.destination.parent : null;
      const observed =
        parent?.kind === "folder"
          ? await input.transport.lookupIdentity(intent!.projectId, {
              kind: "folder",
              id: parent.folderId,
            })
          : null;
      return prepareFolderNamespaceAttempt(record, ids, () =>
        observed?.kind === "available" ? observed.location : null,
      );
    },
    repair: (record, intentId) =>
      replaceIntent(record, intentId, (current) => ({ ...current, state: "needs-repair" })),
    recordOutcome: recordFolderNamespaceOutcome,
    settle: (record: FolderNamespaceRecord) => settleFolderNamespaceOutcome(record, input.now?.()),
    // A changed source path must reach the server for an authoritative, identity-bound
    // outcome. The immutable request may be refused, but can never wait for a receipt forever.
    replayEligible: (record, _intent, attempt) => {
      const request = attempt.request;
      if (request.kind === "create") return false;
      if (request.kind === "create-folder") return request.body.folderId === record.folderId;
      return (
        !record.canonicalRefresh &&
        request.body.expected.kind === "folder" &&
        request.body.expected.nodeId === record.folderId
      );
    },
  });
}
