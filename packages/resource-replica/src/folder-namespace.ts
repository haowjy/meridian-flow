/** Folder placement uses the same durable namespace journal without inventing document content. */

import { validateNamespaceJournal } from "./namespace-journal-policy";
import { owningLocationIntent, supersedeRepairableNamespaceWork } from "./resource-intent-policy";
import {
  activeNamespaceIntent,
  type NamespaceAttemptIds,
  type NamespaceReconcileResult,
  namespaceAttemptWithOutcome,
  namespaceOutcomeMatches,
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
} from "./resource-records";
import { workAuthorityOf } from "./resource-records";
import { resourceContextAuthority } from "./resource-work-authority";

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
    ...workAuthorityOf(destination),
  };
}

export function projectFolderNeedsRepair(
  record: FolderNamespaceRecord,
): { intentId: string; name: string } | null {
  const failed = record.intents.find((intent) => intent.state === "needs-repair");
  if (failed?.desired.kind !== "set-folder-location") return null;
  // Keep the refused receipt as the repair anchor, but offer the writer's newest
  // destination from the cancelled chain without rewriting immutable intentions.
  const latest = record.intents.reduce(
    (candidate, intent) =>
      intent.state === "cancelled" &&
      intent.desired.kind === "set-folder-location" &&
      intent.sequence > candidate.sequence
        ? intent
        : candidate,
    failed,
  );
  return latest.desired.kind === "set-folder-location"
    ? { intentId: failed.intentId, name: latest.desired.destination.name }
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
    source.workId === destination.workId &&
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
        intent.desired.kind !== "set-folder-location",
    )
  )
    throw new Error("Folder journal only admits folder placement");
  if (
    next.intents.some((intent) =>
      intent.attempts.some(
        (attempt) =>
          attempt.request.kind !== "move" ||
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
    intent.desired.kind !== "set-folder-location" ||
    record.canonicalRefresh
  )
    return null;
  const source = record.canonical;
  const destination = intent.desired.destination;
  const request: Extract<NamespaceRequest, { kind: "move" }> = {
    kind: "move",
    scheme: source.scheme,
    sourceWorkSlug: source.workSlug ?? null,
    destinationWorkSlug: destination.workSlug ?? null,
    body: {
      operationId: intent.operationId ?? ids.operationId,
      path: pathParts(source.path).join("/"),
      expected: { kind: "folder", nodeId: record.folderId },
      destinationScheme: destination.scheme,
      destinationFolderPath: pathParts(destination.folderPath).join("/"),
      sourceWorkId: source.workId,
      destinationWorkId: destination.workId,
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
    outcome?.kind !== "operation" ||
    outcome.receipt.command.kind !== "move"
  )
    return null;
  const write = replaceIntent(record, intent.intentId, (current) => ({
    ...current,
    state: outcome.receipt.result.ok ? "settled" : "needs-repair",
    settledAt,
  }));
  if (outcome.receipt.result.ok) {
    write.next.canonicalRefresh = { operationId: outcome.receipt.operationId };
  } else {
    // These commands were queued against an optimistic placement the server refused.
    // Keep the failure on the accepted folder; a new command starts from that location.
    write.next.intents = write.next.intents.map((queued) =>
      queued.sequence > intent.sequence &&
      queued.state === "pending" &&
      queued.attempts.length === 0
        ? { ...queued, state: "cancelled" }
        : queued,
    );
  }
  return write;
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
      if (attempt.request.kind !== "move") return false;
      const request = attempt.request;
      return (
        !record.canonicalRefresh &&
        request.body.expected.kind === "folder" &&
        request.body.expected.nodeId === record.folderId
      );
    },
  });
}
