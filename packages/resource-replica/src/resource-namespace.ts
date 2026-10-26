/** Durable namespace reconciliation: pure record transitions around an account-bound transport. */
import {
  isOwnedContextScheme,
  type ParsedContextAuthority,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import type {
  ContextOperationReceipt,
  CreateUntitledContextDocumentResponse,
  CreateUntitledDestination,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { canonicalRefreshObservation } from "./canonical-observation";
import {
  namespaceIntentOutcome,
  resolveUnavailableNamespace,
  settleNamespaceIntent,
} from "./namespace-journal-policy";
import type { PlacementVerdict } from "./placement-journal";
import { committedResourceDeletion } from "./resource-deletion";
import { followedJoin, pendingJoinTarget } from "./resource-join";
import type {
  DestinationParentLookup,
  NamespaceAttempt,
  NamespaceIdentityAvailability,
  NamespaceIntent,
  NamespaceOutcome,
  NamespaceRequest,
  ResourceDestination,
  ResourceLocation,
  ResourceMetadataStore,
  ResourceNamespaceLock,
  ResourceNamespaceTransport,
  ResourceOwnerKey,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";
import { destinationParentLocation, sameOwner } from "./resource-records";
import { moveOwnerFields, resourceContextAuthority } from "./resource-work-authority";

type AttemptOf<Kind extends NamespaceRequest["kind"]> = Extract<
  NamespaceAttempt,
  { request: { kind: Kind } }
>;
type ReceiptOf<Kind extends ContextOperationReceipt["command"]["kind"]> = Extract<
  ContextOperationReceipt,
  { command: { kind: Kind } }
>;

export type NamespaceAttemptIds = Readonly<{ attemptId: string; operationId: string }>;
export type NamespaceReconcileResult =
  | "idle"
  | "blocked"
  | "progressed"
  | "uncertain"
  | "needs-repair"
  /** The create was answered `joined`; the app re-identifies the reservation, then reconciles again. */
  | "needs-join";

export function activeNamespaceIntent(record: {
  intents: readonly NamespaceIntent[];
}): NamespaceIntent | null {
  return (
    [...record.intents]
      .sort((left, right) => left.sequence - right.sequence)
      .find(
        (intent) =>
          intent.state !== "cancelled" &&
          intent.state !== "settled" &&
          intent.state !== "superseded" &&
          intent.state !== "unexecutable-after-terminal" &&
          intent.state !== "settled-locally",
      ) ?? null
  );
}

function normalizedPath(path: string): string {
  return path.replace(/^\/+/, "");
}

function displayedPath(path: string): string {
  return `/${normalizedPath(path)}`;
}

function sameSource(location: ResourceLocation | null, request: NamespaceRequest): boolean {
  if (!location || request.kind === "create") return request.kind === "create";
  return (
    location.scheme === request.scheme &&
    normalizedPath(location.path) === normalizedPath(request.body.path) &&
    sameOwner(location, requestSourceOwner(request))
  );
}

/** The owner a move or delete request names for its source. */
function requestSourceOwner(
  request: Extract<NamespaceRequest, { kind: "move" | "delete" }>,
): ResourceOwnerKey {
  return request.kind === "delete"
    ? { workId: request.workId, workHandle: request.workHandle, rootThreadId: request.rootThreadId }
    : {
        workId: request.body.sourceWorkId ?? null,
        workHandle: request.sourceWorkHandle,
        rootThreadId: request.body.sourceRootThreadId,
      };
}

function requestFor(
  record: ResourceRecord,
  intent: NamespaceIntent,
  operationId: string,
  lookup: DestinationParentLookup,
): NamespaceRequest | null {
  const { resource } = record;
  if (resource.obligations.canonicalRefresh) return null;
  if (intent.desired.kind === "create") {
    if (
      resource.lifecycle.kind !== "local" ||
      resource.canonical ||
      resource.obligations.createEligibility?.eligibleAt == null ||
      (resource.content.kind === "exact" && resource.content.initialization === "reserved")
    )
      return null;
    return {
      kind: "create",
      body: {
        documentId: resource.identity.documentId,
        ...(intent.desired.destination
          ? { destination: createDestination(intent.desired.destination) }
          : intent.desired.folderPath
            ? { folderPath: normalizedPath(intent.desired.folderPath) }
            : {}),
      },
    };
  }
  const source = resource.canonical;
  if (!source) return null;
  if (intent.desired.kind === "delete") {
    return {
      kind: "delete",
      scheme: source.scheme,
      workId: source.workId,
      workHandle: source.workHandle ?? null,
      rootThreadId: source.rootThreadId ?? null,
      rootThreadRef: source.rootThreadRef ?? null,
      body: {
        operationId,
        path: normalizedPath(source.path),
        expected: { kind: "file", documentId: resource.identity.documentId },
      },
    };
  }
  const destination = intent.desired.destination;
  const parent = destinationParentLocation(destination.parent, lookup);
  if (!parent) return null;
  const owners = moveOwnerFields(source, parent);
  return {
    kind: "move",
    scheme: source.scheme,
    ...owners,
    body: {
      operationId,
      path: normalizedPath(source.path),
      expected: { kind: "file", nodeId: resource.identity.documentId },
      destinationParent: {
        ...destination.parent,
        ...(destination.createFolders?.length ? { createFolders: destination.createFolders } : {}),
      },
      destinationScheme: parent.scheme,
      destinationFolderPath: [normalizedPath(parent.path), ...(destination.createFolders ?? [])]
        .filter(Boolean)
        .join("/"),
      ...owners.body,
      newName: intent.desired.kind === "set-location" ? intent.desired.typedName : destination.name,
      ...(destination.position ? { position: destination.position } : {}),
    },
  };
}

/** The create carries what a move would: the server resolves the parent by identity. */
function createDestination(destination: ResourceDestination): CreateUntitledDestination {
  return {
    parent: {
      ...destination.parent,
      ...(destination.createFolders?.length ? { createFolders: destination.createFolders } : {}),
    },
    name: destination.name,
  };
}

function replaceIntent(
  record: ResourceRecord,
  intentId: string,
  replace: (intent: NamespaceIntent) => NamespaceIntent,
): ResourceRecord {
  return {
    resource: { ...record.resource, revision: record.resource.revision + 1 },
    intents: record.intents.map((intent) =>
      intent.intentId === intentId ? replace(intent) : intent,
    ),
  };
}

/** Persist the immutable request before any transport can observe it. */
export function prepareNamespaceAttempt(
  record: ResourceRecord,
  ids: NamespaceAttemptIds,
  lookup: DestinationParentLookup = () => null,
): ResourceWrite | null {
  const intent = activeNamespaceIntent(record);
  if (intent?.state !== "pending") return null;
  if (record.resource.lifecycle.kind === "terminal")
    return {
      expectedRevision: record.resource.revision,
      next: {
        resource: { ...record.resource, revision: record.resource.revision + 1 },
        intents: resolveUnavailableNamespace(record.intents, true),
      },
    };
  if (intent.identityRevision !== record.resource.identity.revision) {
    return {
      expectedRevision: record.resource.revision,
      next: replaceIntent(record, intent.intentId, (current) => ({
        ...current,
        state: "needs-repair",
      })),
    };
  }
  if (
    (intent.desired.kind === "set-location" || intent.desired.kind === "set-folder-location") &&
    !destinationParentLocation(intent.desired.destination.parent, lookup)
  )
    return {
      expectedRevision: record.resource.revision,
      next: replaceIntent(record, intent.intentId, (current) => ({
        ...current,
        state: "needs-repair",
      })),
    };
  const request = requestFor(record, intent, intent.operationId ?? ids.operationId, lookup);
  if (!request) return null;
  const next = replaceIntent(record, intent.intentId, (current) => ({
    ...current,
    state: "submitted",
    attempts: [...current.attempts, unrecordedAttempt(ids.attemptId, request)],
  }));
  return { expectedRevision: record.resource.revision, next };
}

function unrecordedAttempt(attemptId: string, request: NamespaceRequest): NamespaceAttempt {
  switch (request.kind) {
    case "create":
      return { attemptId, request };
    case "move":
      return { attemptId, request };
    case "delete":
      return { attemptId, request };
  }
}

export function namespaceOutcomeMatches(
  attempt: NamespaceAttempt,
  outcome: NamespaceOutcome,
): boolean {
  if (attempt.request.kind === "create") {
    return (
      outcome.kind === "create" &&
      (outcome.result.status === "conflict" ||
        outcome.result.status === "joined" ||
        outcome.result.documentId === attempt.request.body.documentId)
    );
  }
  if (outcome.kind === "refusal")
    return outcome.operationId === attempt.request.body.operationId && !outcome.error.retryable;
  if (
    outcome.kind !== "operation" ||
    outcome.receipt.operationId !== attempt.request.body.operationId ||
    outcome.receipt.command.kind !== attempt.request.kind
  )
    return false;
  const receipt = outcome.receipt;
  if (attempt.request.kind === "delete" && namespaceReceiptIs(receipt, "delete")) {
    const source = parseContextUri(receipt.command.uri);
    return (
      source.ok &&
      source.value.scheme === attempt.request.scheme &&
      source.value.path === normalizedPath(attempt.request.body.path) &&
      authorityMatches(attempt.request.scheme, source.value.authority, attempt.request) &&
      JSON.stringify(receipt.command.expected) === JSON.stringify(attempt.request.body.expected)
    );
  }
  if (attemptIs(attempt, "move") && namespaceReceiptIs(receipt, "move")) {
    const source = parseContextUri(receipt.command.sourceUri);
    const destination = parseContextUri(receipt.command.destinationUri);
    const destinationParentPath = destination.ok
      ? destination.value.path.split("/").slice(0, -1).join("/")
      : "";
    return (
      source.ok &&
      destination.ok &&
      source.value.scheme === attempt.request.scheme &&
      source.value.path === normalizedPath(attempt.request.body.path) &&
      authorityMatches(attempt.request.scheme, source.value.authority, {
        workId: attempt.request.body.sourceWorkId ?? null,
        workHandle: attempt.request.sourceWorkHandle,
        rootThreadId: attempt.request.body.sourceRootThreadId,
        rootThreadRef: attempt.request.sourceRootThreadRef,
      }) &&
      sameDestinationParent(
        receipt.command.destinationParent,
        attempt.request.body.destinationParent,
      ) &&
      JSON.stringify(receipt.command.position) === JSON.stringify(attempt.request.body.position) &&
      (attempt.request.body.destinationParent?.kind === "folder"
        ? true
        : destination.value.scheme === attempt.request.body.destinationScheme &&
          destinationParentPath === normalizedPath(attempt.request.body.destinationFolderPath) &&
          authorityMatches(attempt.request.body.destinationScheme, destination.value.authority, {
            workId: attempt.request.body.destinationWorkId ?? null,
            workHandle: attempt.request.destinationWorkHandle,
            rootThreadId: attempt.request.body.destinationRootThreadId,
            rootThreadRef: attempt.request.destinationRootThreadRef,
          })) &&
      JSON.stringify(receipt.command.expected) === JSON.stringify(attempt.request.body.expected)
    );
  }
  return false;
}

function sameDestinationParent(
  left: Extract<NamespaceRequest, { kind: "move" }>["body"]["destinationParent"],
  right: Extract<NamespaceRequest, { kind: "move" }>["body"]["destinationParent"],
): boolean {
  if (!left || !right) return left === right;
  if (JSON.stringify(left.createFolders ?? []) !== JSON.stringify(right.createFolders ?? []))
    return false;
  if (left.kind === "folder" || right.kind === "folder")
    return left.kind === "folder" && right.kind === "folder" && left.folderId === right.folderId;
  return left.scheme === right.scheme && sameOwner(left.owner, right.owner);
}

function authorityMatches(
  scheme: ProjectContextTreeScheme,
  authority: ParsedContextAuthority,
  owner: Parameters<typeof resourceContextAuthority>[1],
): boolean {
  const expected = resourceContextAuthority(scheme, owner);
  // A chat's bare uploads URI parses as contextual: the handle exists only after creation.
  const expectedKind =
    expected.kind === "chat" && expected.chatRef === null ? "contextual" : expected.kind;
  return (
    authority.kind === expectedKind &&
    (authority.kind !== "work" ||
      (expected.kind === "work" && authority.workHandle === expected.workHandle)) &&
    (authority.kind !== "lineage" ||
      (expected.kind === "lineage" && authority.rootThreadRef === expected.rootThreadRef)) &&
    (authority.kind !== "chat" ||
      (expected.kind === "chat" && authority.chatRef === expected.chatRef))
  );
}

function attemptIs<Kind extends NamespaceRequest["kind"]>(
  attempt: NamespaceAttempt,
  kind: Kind,
): attempt is AttemptOf<Kind> {
  return attempt.request.kind === kind;
}

export function namespaceReceiptIs<Kind extends ContextOperationReceipt["command"]["kind"]>(
  receipt: ContextOperationReceipt,
  kind: Kind,
): receipt is ReceiptOf<Kind> {
  return receipt.command.kind === kind;
}

export function namespaceAttemptWithOutcome(
  attempt: NamespaceAttempt,
  outcome: NamespaceOutcome,
): NamespaceAttempt {
  if (attemptIs(attempt, "create") && outcome.kind === "create")
    return { attemptId: attempt.attemptId, request: attempt.request, outcome };
  if (outcome.kind === "refusal" && (attemptIs(attempt, "move") || attemptIs(attempt, "delete")))
    return { ...attempt, outcome };
  if (
    attemptIs(attempt, "move") &&
    outcome.kind === "operation" &&
    namespaceReceiptIs(outcome.receipt, "move")
  )
    return {
      attemptId: attempt.attemptId,
      request: attempt.request,
      outcome: { kind: "operation", receipt: outcome.receipt },
    };
  if (
    attemptIs(attempt, "delete") &&
    outcome.kind === "operation" &&
    namespaceReceiptIs(outcome.receipt, "delete")
  )
    return {
      attemptId: attempt.attemptId,
      request: attempt.request,
      outcome: { kind: "operation", receipt: outcome.receipt },
    };
  throw new Error("Namespace outcome does not match current attempt");
}

/** Record transport evidence without applying it to current resource identity or location. */
export function recordNamespaceOutcome(
  record: ResourceRecord,
  intentId: string,
  attemptId: string,
  outcome: NamespaceOutcome,
): ResourceWrite | null {
  const intent = record.intents.find((candidate) => candidate.intentId === intentId);
  const attempt = intent?.attempts.at(-1);
  if (!intent || !attempt || attempt.attemptId !== attemptId)
    throw new Error("Namespace attempt is no longer current");
  if (attempt.outcome) return null;
  if (intent.state !== "submitted" || !namespaceOutcomeMatches(attempt, outcome))
    throw new Error("Namespace outcome does not match current attempt");
  const next = replaceIntent(record, intentId, (current) => ({
    ...current,
    state: "received",
    attempts: current.attempts.map((candidate) =>
      candidate.attemptId === attemptId
        ? namespaceAttemptWithOutcome(candidate, outcome)
        : candidate,
    ),
  }));
  return { expectedRevision: record.resource.revision, next };
}

function createLocation(result: CreateUntitledContextDocumentResponse): ResourceLocation | null {
  // The create response names a Work by id alone; a Work-scoped location
  // waits for the catalog observation, which carries the Work's handle.
  if (result.workId) return null;
  return {
    scheme: result.scheme,
    path: displayedPath(result.path),
    name: result.name,
    workId: null,
  };
}

/** Apply a recorded historical outcome without overwriting newer observed identity/location. */
export function settleNamespaceOutcome(
  record: ResourceRecord,
  settledAt = Date.now(),
  /** Another record already holds the joined id: the create cannot join and is repaired. */
  joinTaken = false,
): ResourceWrite | null {
  const intent = activeNamespaceIntent(record);
  const attempt = intent?.attempts.at(-1);
  const outcome = attempt?.outcome;
  if (intent?.state !== "received" || !attempt || !outcome) return null;
  let repair = false;
  let resource = record.resource;
  const identityStillMatches = intent.identityRevision === resource.identity.revision;
  if (resource.lifecycle.kind === "terminal") {
    // Terminal authority supersedes older historical namespace effects.
  } else if (
    outcome.kind === "create" &&
    outcome.result.status === "joined" &&
    attemptIs(attempt, "create")
  ) {
    // Following the join re-identifies the session, which the app brackets; settling only
    // records that it happened.
    if (!followedJoin(record, attempt.request.body.documentId, outcome.result.documentId)) {
      if (!joinTaken) return null;
      repair = true;
    }
  } else if (outcome.kind === "create") {
    if (
      outcome.result.status === "conflict" ||
      outcome.result.status === "joined" ||
      !identityStillMatches
    )
      repair = true;
    else {
      if (resource.content.kind !== "exact" || resource.content.initialization === "reserved")
        throw new Error("Created resource content is not initialized");
      const { createEligibility: _eligible, ...obligations } = resource.obligations;
      resource = {
        ...resource,
        canonical: resource.canonical ?? createLocation(outcome.result),
        lifecycle:
          resource.lifecycle.kind === "local"
            ? { kind: "acknowledged", availabilityGeneration: null }
            : resource.lifecycle,
        obligations: {
          ...obligations,
          sessionAdoption: {
            transitionId: attempt.attemptId,
            projectId: intent.projectId,
            documentId: resource.identity.documentId,
            identityRevision: resource.identity.revision,
            exactDatabaseName: resource.content.databaseName,
          },
        },
      };
    }
  } else if (outcome.kind === "refusal") {
    repair = true;
  } else if (attemptIs(attempt, "move")) {
    const receipt = outcome.receipt;
    if (!namespaceReceiptIs(receipt, "move") || !receipt.result.ok || !identityStillMatches)
      repair = true;
    else {
      // A historical move receipt proves its command outcome, not the current location.
      // Its refresh obligation blocks later dispatch until a post-receipt catalog read.
      resource = {
        ...resource,
        obligations: {
          ...resource.obligations,
          canonicalRefresh: {
            operationId: receipt.operationId,
            identityRevision: intent.identityRevision,
            observationVersion: receipt.observationVersion,
          },
        },
      };
    }
  } else if (attemptIs(attempt, "delete")) {
    const receipt = outcome.receipt;
    if (!namespaceReceiptIs(receipt, "delete")) repair = true;
    else {
      const result = receipt.result;
      if (
        !result.ok ||
        !identityStillMatches ||
        !result.value.removed.some(({ documentId }) => documentId === resource.identity.documentId)
      )
        repair = true;
      else {
        resource = committedResourceDeletion(
          resource,
          result.value.availabilityGeneration,
          receipt.operationId,
          receipt.observationVersion,
        );
      }
    }
  } else repair = true;
  const disposition = namespaceIntentOutcome(
    outcome,
    record.resource.lifecycle.kind === "terminal",
  );
  const next: ResourceRecord = {
    resource: { ...resource, revision: record.resource.revision + 1 },
    intents: settleNamespaceIntent(
      record.intents,
      intent,
      disposition === "accepted" && repair ? "refused" : disposition,
      settledAt,
    ),
  };
  return { expectedRevision: record.resource.revision, next };
}

/** Install a catalog observation acquired after the matching move receipt. */
export function installCanonicalRefresh(input: {
  record: ResourceRecord;
  operationId: string;
  location: ResourceLocation;
  parent: import("./resource-records").ParentRef;
  rank?: string | null;
  locationVersion?: string;
  observationVersion: string;
}): ResourceWrite | null {
  const obligation = input.record.resource.obligations.canonicalRefresh;
  if (!obligation || obligation.operationId !== input.operationId) return null;
  if (
    input.record.resource.lifecycle.kind === "terminal" ||
    obligation.identityRevision !== input.record.resource.identity.revision
  )
    return null;
  const { newer, completes } = canonicalRefreshObservation(
    input.observationVersion,
    input.record.resource.observationVersion,
    obligation.observationVersion,
  );
  if (!newer && !completes) return null;
  // A catalog observation names its Work by id with its handle, null for No Work
  // (`@/`), exactly as catalog installation derives it from the entry's URI.
  // A lineage's Scratch names its first chat, and chat uploads name their chat.
  // Only an owned scheme's location with no owner is incomplete.
  const hasOwner =
    input.location.workId != null ||
    input.location.rootThreadId !== undefined ||
    input.location.chatId !== undefined;
  if (
    (isOwnedContextScheme(input.location.scheme) && !hasOwner) ||
    (!isOwnedContextScheme(input.location.scheme) &&
      (hasOwner || input.location.workId !== null || input.location.workHandle != null))
  )
    throw new Error("Canonical observation has incomplete owner authority");
  const { canonicalRefresh: _completed, ...obligations } = input.record.resource.obligations;
  return {
    expectedRevision: input.record.resource.revision,
    next: {
      resource: {
        ...input.record.resource,
        revision: input.record.resource.revision + 1,
        ...(newer
          ? {
              canonical: input.location,
              canonicalParent: input.parent,
              canonicalRank: input.rank,
              canonicalLocationVersion: input.locationVersion,
              observationVersion: input.observationVersion,
            }
          : {}),
        obligations: completes ? obligations : input.record.resource.obligations,
      },
      intents: input.record.intents,
    },
  };
}

/** Exact-ID lookup resolves a refresh even when the identity left the requested catalog scope. */
export function installNamespaceAvailability(
  record: ResourceRecord,
  operationId: string,
  availability: NamespaceIdentityAvailability,
): ResourceWrite | null {
  if (record.resource.obligations.canonicalRefresh?.operationId !== operationId) return null;
  if (availability.kind === "available")
    return installCanonicalRefresh({
      record,
      operationId,
      location: availability.location,
      parent: availability.parent,
      rank: availability.rank,
      locationVersion: availability.locationVersion,
      observationVersion: availability.observationVersion,
    });
  const { canonicalRefresh: _completed, ...obligations } = record.resource.obligations;
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: { ...record.resource, revision: record.resource.revision + 1, obligations },
      // Availability is not a document deletion receipt. Preserve it as a repair, not terminal content authority.
      intents: resolveUnavailableNamespace(
        record.intents,
        record.resource.lifecycle.kind === "terminal",
      ),
    },
  };
}

function replayEligible(
  record: ResourceRecord,
  intent: NamespaceIntent,
  attempt: NamespaceAttempt,
) {
  if (record.resource.lifecycle.kind === "terminal") return false;
  // A create that followed a join replays under its old id, which the server forwards.
  if (attempt.request.kind === "create")
    return (
      (attempt.request.body.documentId === record.resource.identity.documentId &&
        intent.identityRevision === record.resource.identity.revision) ||
      record.resource.aliases[attempt.request.body.documentId] !== undefined
    );
  if (intent.identityRevision !== record.resource.identity.revision) return false;
  return sameSource(record.resource.canonical, attempt.request);
}

/** Reconcile one resource through at most one network dispatch; CAS retries never redispatch. */
export function reconcileResourceNamespace(input: {
  key: { handle: string };
  metadata: ResourceMetadataStore;
  transport: ResourceNamespaceTransport;
  lock: ResourceNamespaceLock;
  newAttemptIds: () => NamespaceAttemptIds;
  gate?: NamespaceGate;
  now?: () => number;
}): Promise<NamespaceReconcileResult> {
  return reconcileNamespaceJournal({
    ...input,
    read: () => input.metadata.readResource(input.key),
    commit: (write: ResourceWrite) => input.metadata.commitResource(write),
    prepare: async (record, ids) => {
      const intent = activeNamespaceIntent(record);
      const parent =
        intent?.desired.kind === "set-location" ? intent.desired.destination.parent : null;
      const observed =
        parent?.kind === "folder"
          ? await input.transport.lookupIdentity(intent!.projectId, {
              kind: "folder",
              id: parent.folderId,
            })
          : null;
      return prepareNamespaceAttempt(record, ids, () =>
        observed?.kind === "available" ? observed.location : null,
      );
    },
    repair: (record, intentId) => ({
      expectedRevision: record.resource.revision,
      next: replaceIntent(record, intentId, (current) => ({ ...current, state: "needs-repair" })),
    }),
    recordOutcome: recordNamespaceOutcome,
    settle: (record: ResourceRecord) => settleNamespaceOutcome(record, input.now?.()),
    pendingJoin: (record: ResourceRecord) => pendingJoinTarget(record) !== null,
    replayEligible,
    refresh: async (record) => {
      const barrier = record.resource.obligations.canonicalRefresh;
      if (!barrier) return null;
      const intent = record.intents.find((i) =>
        i.attempts.some(
          (a) => a.request.kind !== "create" && a.request.body.operationId === barrier.operationId,
        ),
      );
      if (!intent) return null;
      return installNamespaceAvailability(
        record,
        barrier.operationId,
        await input.transport.lookupIdentity(intent.projectId, {
          kind: "file",
          id: record.resource.identity.documentId,
        }),
      );
    },
  });
}

/** Whether a pending placement may dispatch now (see `placementDispatchVerdict`). */
export type NamespaceGate = (intent: NamespaceIntent) => Promise<PlacementVerdict>;

/** Shared journal replay for content resources and folder namespace records. */
export async function reconcileNamespaceJournal<
  Record extends { intents: readonly NamespaceIntent[] },
  Write extends { next: Record },
>(input: {
  key: { handle: string };
  metadata: { accountId: string };
  transport: ResourceNamespaceTransport;
  lock: ResourceNamespaceLock;
  newAttemptIds: () => NamespaceAttemptIds;
  read: () => Promise<Record | null>;
  commit: (write: Write) => Promise<"committed" | "stale">;
  /** Holds a pending placement behind its predecessors, or sends it to repair when their failure changed its premise. */
  gate?: NamespaceGate;
  prepare: (record: Record, ids: NamespaceAttemptIds) => Write | null | Promise<Write | null>;
  /** Marks a pending intent as needing the writer's repair, as when its destination is gone. */
  repair: (record: Record, intentId: string) => Write;
  recordOutcome: (
    record: Record,
    intentId: string,
    attemptId: string,
    outcome: NamespaceOutcome,
  ) => Write | null;
  settle: (record: Record) => Write | null;
  /** A received outcome that only the app can settle (it brackets a session re-identification). */
  pendingJoin?: (record: Record) => boolean;
  refresh: (record: Record) => Promise<Write | null>;
  replayEligible: (record: Record, intent: NamespaceIntent, attempt: NamespaceAttempt) => boolean;
}): Promise<NamespaceReconcileResult> {
  if (
    input.metadata.accountId !== input.transport.accountId ||
    input.metadata.accountId !== input.lock.accountId
  )
    throw new Error("Resource namespace account mismatch");
  let captured: { intentId: string; attemptId: string; outcome: NamespaceOutcome } | undefined;
  for (;;) {
    const record = await input.read();
    if (!record) return "idle";
    const refreshed = await input.refresh(record);
    if (refreshed) {
      if ((await input.commit(refreshed)) === "stale") continue;
      return "progressed";
    }
    const intent = activeNamespaceIntent(record);
    if (!intent) return "idle";
    if (intent.state === "needs-repair") return "needs-repair";
    if (intent.state === "pending") {
      const verdict = (await input.gate?.(intent)) ?? "go";
      if (verdict === "wait") return "blocked";
      const write =
        verdict === "repair"
          ? input.repair(record, intent.intentId)
          : await input.prepare(record, input.newAttemptIds());
      if (!write) return "blocked";
      if ((await input.commit(write)) === "stale") continue;
      if (
        write.next.intents.find((item) => item.intentId === intent.intentId)?.state ===
        "needs-repair"
      )
        return "needs-repair";
      continue;
    }
    if (intent.state === "received") {
      const write = input.settle(record);
      if (!write) return input.pendingJoin?.(record) ? "needs-join" : "idle";
      if ((await input.commit(write)) === "stale") continue;
      return write.next.intents.find((item) => item.intentId === intent.intentId)?.state ===
        "needs-repair"
        ? "needs-repair"
        : "progressed";
    }
    if (intent.state !== "submitted") return "idle";
    const attempt = intent.attempts.at(-1);
    if (!attempt) throw new Error("Submitted intention has no attempt");
    if (!captured) {
      const locked = await input.lock.run(input.key, async () => {
        const observed = await input.transport.readOutcome(intent.projectId, attempt.request);
        if (observed) return observed;
        // Identity and terminal transitions use this same lock. Re-read after
        // lookup so a transition cannot make the captured snapshot authorize dispatch.
        const current = await input.read();
        const currentIntent = current && activeNamespaceIntent(current);
        const currentAttempt = currentIntent?.attempts.at(-1);
        if (
          !current ||
          currentIntent?.intentId !== intent.intentId ||
          currentAttempt?.attemptId !== attempt.attemptId ||
          currentIntent.state !== "submitted" ||
          !input.replayEligible(current, currentIntent, currentAttempt)
        )
          return null;
        return input.transport.submit(currentIntent.projectId, currentAttempt.request);
      });
      if (locked.kind === "busy") return "blocked";
      const outcome = locked.value;
      if (!outcome) return "uncertain";
      captured = { intentId: intent.intentId, attemptId: attempt.attemptId, outcome };
    }
    if (intent.intentId !== captured.intentId || attempt.attemptId !== captured.attemptId)
      return "progressed";
    const write = input.recordOutcome(
      record,
      captured.intentId,
      captured.attemptId,
      captured.outcome,
    );
    if (!write) continue;
    if ((await input.commit(write)) === "stale") continue;
  }
}
