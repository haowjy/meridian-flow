/** Folder placement and recursive deletion share the account namespace journal, without document content. */

import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import {
  cancelRefusedLocationChain,
  namespaceRepairDestination,
  validateNamespaceJournal,
} from "./namespace-journal-policy";
import { committedResourceDeletion } from "./resource-deletion";
import {
  intentOwnsDeletion,
  owningLocationIntent,
  supersedeRepairableNamespaceWork,
} from "./resource-intent-policy";
import {
  activeNamespaceIntent,
  type NamespaceAttemptIds,
  type NamespaceReconcileResult,
  namespaceAttemptWithOutcome,
  namespaceOutcomeMatches,
  namespaceReceiptIs,
  reconcileNamespaceJournal,
} from "./resource-namespace";
import type {
  FolderNamespaceRecord,
  FolderNamespaceWrite,
  MetadataCommitResult,
  NamespaceIntent,
  NamespaceOutcome,
  NamespaceRequest,
  ResourceDestination,
  ResourceKey,
  ResourceLocation,
  ResourceNamespaceLock,
  ResourceNamespaceTransport,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";
import { ownerOf, sameOwner } from "./resource-records";
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

export function namespaceDestinationLocation(destination: ResourceDestination): ResourceLocation {
  return {
    scheme: destination.scheme,
    path: `/${[...pathParts(destination.folderPath), destination.name].join("/")}`,
    name: destination.name,
    ...ownerOf(destination),
  };
}

export function projectFolderNeedsRepair(record: FolderNamespaceRecord): {
  intentId: string;
  kind: "delete" | "set-location";
  name: string;
  destination?: ResourceDestination;
} | null {
  const failed = record.intents.find((intent) => intent.state === "needs-repair");
  if (failed?.desired.kind === "delete")
    return { intentId: failed.intentId, kind: "delete", name: record.canonical.name };
  if (failed?.desired.kind !== "set-folder-location") return null;
  const destination = namespaceRepairDestination(record.intents, failed);
  return destination
    ? { intentId: failed.intentId, kind: "set-location", name: destination.name, destination }
    : null;
}

/** Work that can progress without a new writer command, as `resourceNeedsBackgroundReconciliation` for files. */
export function folderNeedsBackgroundReconciliation(record: FolderNamespaceRecord): boolean {
  return record.intents.some(
    (intent) =>
      intent.state === "pending" || intent.state === "submitted" || intent.state === "received",
  );
}

export function projectFolderLocation(record: FolderNamespaceRecord): ResourceLocation {
  const desired = owningLocationIntent(
    record.projectId,
    record.intents,
    Boolean(record.canonicalRefresh),
  )?.desired;
  return desired?.kind === "set-folder-location"
    ? namespaceDestinationLocation(desired.destination)
    : record.canonical;
}

export function folderOwnsDeletion(record: FolderNamespaceRecord): boolean {
  return record.intents.some(intentOwnsDeletion);
}

/** Recursive deletion is namespace work; its receipt settles descendants atomically. */
export function planFolderDeletion(input: {
  record?: FolderNamespaceRecord | null;
  projectId: string;
  handle: string;
  folderId: string;
  source: ResourceLocation;
  intentId: string;
  operationId: string;
}): FolderNamespaceWrite | null {
  const previous = input.record ?? null;
  if (
    previous &&
    ((previous.projectId !== null && previous.projectId !== input.projectId) ||
      previous.handle !== input.handle ||
      previous.folderId !== input.folderId)
  )
    throw new Error("Folder namespace identity mismatch");
  const record: FolderNamespaceRecord = previous ?? {
    projectId: input.source.scheme === "user" ? null : input.projectId,
    handle: input.handle,
    folderId: input.folderId,
    revision: 0,
    canonical: input.source,
    intents: [],
  };
  if (folderOwnsDeletion(record)) return null;
  resourceContextAuthority(record.canonical.scheme, record.canonical);
  const superseded = supersedeRepairableNamespaceWork(record, record.projectId);
  return {
    expectedRevision: previous?.revision ?? null,
    next: {
      ...record,
      revision: record.revision + 1,
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
          attempts: [],
          state: "pending",
        },
      ],
    },
  };
}

/** New folder records reserve only namespace identity, never a Yjs database or document id. */
export function planFolderLocation(input: {
  record?: FolderNamespaceRecord | null;
  projectId: string;
  handle: string;
  folderId: string;
  source: ResourceLocation;
  intentId: string;
  operationId: string;
  destination: ResourceDestination;
}): FolderNamespaceWrite | null {
  const previous = input.record ?? null;
  if (previous && folderOwnsDeletion(previous)) throw new Error("Folder is being deleted");
  if (
    previous &&
    ((previous.projectId !== null && previous.projectId !== input.projectId) ||
      previous.handle !== input.handle ||
      previous.folderId !== input.folderId)
  )
    throw new Error("Folder namespace identity mismatch");
  const record: FolderNamespaceRecord = previous ?? {
    projectId: input.source.scheme === "user" ? null : input.projectId,
    handle: input.handle,
    folderId: input.folderId,
    revision: 0,
    canonical: input.source,
    intents: [],
  };
  resourceContextAuthority(input.destination.scheme, input.destination);
  resourceContextAuthority(record.canonical.scheme, record.canonical);
  if (
    !input.destination.name ||
    input.destination.name.includes("/") ||
    [".", ".."].includes(input.destination.name)
  )
    throw new Error("Invalid folder name");
  const superseded = supersedeRepairableNamespaceWork(
    { intents: record.intents },
    record.projectId,
  );
  const source = projectFolderLocation({ ...record, intents: superseded.intents });
  const destination = namespaceDestinationLocation(input.destination);
  if (
    source.scheme === destination.scheme &&
    sameOwner(source, destination) &&
    (destination.path === source.path || destination.path.startsWith(`${source.path}/`))
  ) {
    if (destination.path === source.path && !superseded.repaired) return null;
    if (destination.path !== source.path) throw new Error("Cannot move a folder inside itself");
  }
  const intent: NamespaceIntent = {
    handle: input.handle,
    projectId: input.projectId,
    intentId: input.intentId,
    operationId: input.operationId,
    sequence: Math.max(0, ...record.intents.map((item) => item.sequence)) + 1,
    identityRevision: 1,
    desired: { kind: "set-folder-location", destination: input.destination },
    attempts: [],
    state: "pending",
  };
  return {
    expectedRevision: previous?.revision ?? null,
    next: {
      ...record,
      revision: record.revision + 1,
      intents: [...superseded.intents, intent],
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
      intent.attempts.some(
        (attempt) =>
          attempt.request.kind === "create" ||
          attempt.request.body.expected.kind !== "folder" ||
          attempt.request.body.expected.nodeId !== next.folderId,
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
  validateNamespaceJournal({ previous, next, identityRevision: 1 });
  resourceContextAuthority(next.canonical.scheme, next.canonical);
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
): FolderNamespaceWrite | null {
  const intent = activeNamespaceIntent(record);
  if (
    intent?.state !== "pending" ||
    (intent.desired.kind !== "set-folder-location" && intent.desired.kind !== "delete") ||
    record.canonicalRefresh
  )
    return null;
  const source = record.canonical;
  if (intent.desired.kind === "delete") {
    const request: Extract<NamespaceRequest, { kind: "delete" }> = {
      kind: "delete",
      scheme: source.scheme,
      workId: source.workId,
      workSlug: source.workSlug ?? null,
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
  const owners = moveOwnerFields(source, destination);
  const request: Extract<NamespaceRequest, { kind: "move" }> = {
    kind: "move",
    scheme: source.scheme,
    ...owners,
    body: {
      operationId: intent.operationId ?? ids.operationId,
      path: pathParts(source.path).join("/"),
      expected: { kind: "folder", nodeId: record.folderId },
      destinationScheme: destination.scheme,
      destinationFolderPath: pathParts(destination.folderPath).join("/"),
      ...owners.body,
      ...(destination.name !== source.name ? { newName: destination.name } : {}),
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
  const accepted = outcome.kind === "operation" && outcome.receipt.result.ok;
  const write = replaceIntent(record, intent.intentId, (current) => ({
    ...current,
    state: accepted ? "settled" : "needs-repair",
    settledAt,
  }));
  if (outcome.kind === "operation" && accepted) {
    if (outcome.receipt.command.kind === "move")
      write.next.canonicalRefresh = { operationId: outcome.receipt.operationId };
  } else {
    write.next.intents = cancelRefusedLocationChain(write.next.intents, intent);
  }
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
  const ids = new Set(result.deletedDocumentIds);
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
): FolderNamespaceWrite | null {
  if (record.canonicalRefresh?.operationId !== operationId) return null;
  resourceContextAuthority(location.scheme, location);
  const { canonicalRefresh: _completed, ...rest } = record;
  return {
    expectedRevision: record.revision,
    next: { ...rest, revision: record.revision + 1, canonical: location },
  };
}

export function reconcileFolderNamespace(input: {
  key: ResourceKey;
  metadata: FolderNamespaceStore;
  transport: ResourceNamespaceTransport;
  lock: ResourceNamespaceLock;
  newAttemptIds: () => NamespaceAttemptIds;
  now?: () => number;
}): Promise<NamespaceReconcileResult> {
  return reconcileNamespaceJournal({
    ...input,
    read: () => input.metadata.readFolder(input.key),
    commit: (write: FolderNamespaceWrite) => input.metadata.commitFolder(write),
    prepare: prepareFolderNamespaceAttempt,
    recordOutcome: recordFolderNamespaceOutcome,
    settle: (record: FolderNamespaceRecord) => settleFolderNamespaceOutcome(record, input.now?.()),
    // A changed source path must reach the server for an authoritative, identity-bound
    // outcome. The immutable request may be refused, but can never wait for a receipt forever.
    replayEligible: (record, _intent, attempt) => {
      if (attempt.request.kind === "create") return false;
      const request = attempt.request;
      return (
        !record.canonicalRefresh &&
        request.body.expected.kind === "folder" &&
        request.body.expected.nodeId === record.folderId
      );
    },
  });
}
