/** Durable namespace reconciliation: pure record transitions around an account-bound transport. */
import { type ParsedContextAuthority, parseContextUri } from "@meridian/contracts/context-uri";
import {
  type ContextOperationReceipt,
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { cancelRefusedLocationChain } from "./namespace-journal-policy";
import type {
  NamespaceAttempt,
  NamespaceIntent,
  NamespaceOutcome,
  NamespaceRequest,
  ResourceLocation,
  ResourceMetadataStore,
  ResourceNamespaceLock,
  ResourceNamespaceTransport,
  ResourceOwnerKey,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";
import { sameOwner } from "./resource-records";
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
  | "needs-repair";

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
    ? { workId: request.workId, workSlug: request.workSlug, rootThreadId: request.rootThreadId }
    : {
        workId: request.body.sourceWorkId ?? null,
        workSlug: request.sourceWorkSlug,
        rootThreadId: request.body.sourceRootThreadId,
      };
}

function requestFor(
  record: ResourceRecord,
  intent: NamespaceIntent,
  operationId: string,
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
        ...(intent.desired.folderPath
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
      workSlug: source.workSlug ?? null,
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
  const owners = moveOwnerFields(source, destination);
  return {
    kind: "move",
    scheme: source.scheme,
    ...owners,
    body: {
      operationId,
      path: normalizedPath(source.path),
      expected: { kind: "file", nodeId: resource.identity.documentId },
      destinationScheme: destination.scheme,
      destinationFolderPath: normalizedPath(destination.folderPath),
      ...owners.body,
      ...(destination.name !== source.name ? { newName: destination.name } : {}),
    },
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
): ResourceWrite | null {
  const intent = activeNamespaceIntent(record);
  if (intent?.state !== "pending") return null;
  if (record.resource.lifecycle.kind === "terminal") return null;
  if (intent.identityRevision !== record.resource.identity.revision) {
    return {
      expectedRevision: record.resource.revision,
      next: replaceIntent(record, intent.intentId, (current) => ({
        ...current,
        state: "needs-repair",
      })),
    };
  }
  const request = requestFor(record, intent, intent.operationId ?? ids.operationId);
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
  if (attempt.request.kind === "delete" && receiptIs(receipt, "delete")) {
    const source = parseContextUri(receipt.command.uri);
    return (
      source.ok &&
      source.value.scheme === attempt.request.scheme &&
      source.value.path === normalizedPath(attempt.request.body.path) &&
      authorityMatches(attempt.request.scheme, source.value.authority, attempt.request) &&
      JSON.stringify(receipt.command.expected) === JSON.stringify(attempt.request.body.expected)
    );
  }
  if (attemptIs(attempt, "move") && receiptIs(receipt, "move")) {
    const source = parseContextUri(receipt.command.sourceUri);
    const destination = parseContextUri(receipt.command.destinationUri);
    const currentName = normalizedPath(attempt.request.body.path).split("/").at(-1) ?? "";
    const destinationPath = [
      normalizedPath(attempt.request.body.destinationFolderPath),
      attempt.request.body.newName ?? currentName,
    ]
      .filter(Boolean)
      .join("/");
    return (
      source.ok &&
      destination.ok &&
      source.value.scheme === attempt.request.scheme &&
      source.value.path === normalizedPath(attempt.request.body.path) &&
      authorityMatches(attempt.request.scheme, source.value.authority, {
        workId: attempt.request.body.sourceWorkId ?? null,
        workSlug: attempt.request.sourceWorkSlug,
        rootThreadId: attempt.request.body.sourceRootThreadId,
        rootThreadRef: attempt.request.sourceRootThreadRef,
      }) &&
      destination.value.scheme === attempt.request.body.destinationScheme &&
      destination.value.path === destinationPath &&
      authorityMatches(attempt.request.body.destinationScheme, destination.value.authority, {
        workId: attempt.request.body.destinationWorkId ?? null,
        workSlug: attempt.request.destinationWorkSlug,
        rootThreadId: attempt.request.body.destinationRootThreadId,
        rootThreadRef: attempt.request.destinationRootThreadRef,
      }) &&
      JSON.stringify(receipt.command.expected) === JSON.stringify(attempt.request.body.expected)
    );
  }
  return false;
}

function authorityMatches(
  scheme: ProjectContextTreeScheme,
  authority: ParsedContextAuthority,
  owner: Parameters<typeof resourceContextAuthority>[1],
): boolean {
  const expected = resourceContextAuthority(scheme, owner);
  return (
    authority.kind === expected.kind &&
    (authority.kind !== "work" ||
      (expected.kind === "work" && authority.workSlug === expected.workSlug)) &&
    (authority.kind !== "lineage" ||
      (expected.kind === "lineage" && authority.rootThreadRef === expected.rootThreadRef))
  );
}

function attemptIs<Kind extends NamespaceRequest["kind"]>(
  attempt: NamespaceAttempt,
  kind: Kind,
): attempt is AttemptOf<Kind> {
  return attempt.request.kind === kind;
}

function receiptIs<Kind extends ContextOperationReceipt["command"]["kind"]>(
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
    receiptIs(outcome.receipt, "move")
  )
    return {
      attemptId: attempt.attemptId,
      request: attempt.request,
      outcome: { kind: "operation", receipt: outcome.receipt },
    };
  if (
    attemptIs(attempt, "delete") &&
    outcome.kind === "operation" &&
    receiptIs(outcome.receipt, "delete")
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

function createLocation(
  result: Exclude<Extract<NamespaceOutcome, { kind: "create" }>["result"], { status: "conflict" }>,
): ResourceLocation | null {
  // The create response names a Work by id alone; a Work-scoped location
  // waits for the catalog observation, which carries the Work's slug.
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
  } else if (outcome.kind === "create") {
    if (outcome.result.status === "conflict" || !identityStillMatches) repair = true;
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
            generation: null,
          },
        },
      };
    }
  } else if (outcome.kind === "refusal") {
    repair = true;
  } else if (attemptIs(attempt, "move")) {
    const receipt = outcome.receipt;
    if (!receiptIs(receipt, "move") || !receipt.result.ok || !identityStillMatches) repair = true;
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
          },
        },
      };
    }
  } else if (attemptIs(attempt, "delete")) {
    const receipt = outcome.receipt;
    if (!receiptIs(receipt, "delete")) repair = true;
    else {
      const result = receipt.result;
      if (
        !result.ok ||
        !identityStillMatches ||
        !result.value.deletedDocumentIds.includes(resource.identity.documentId)
      )
        repair = true;
      else {
        const { sessionAdoption: _superseded, ...obligations } = resource.obligations;
        resource = {
          ...resource,
          canonical: null,
          obligations,
          lifecycle: {
            kind: "terminal",
            generation: result.value.availabilityGeneration,
            transitionId: receipt.operationId,
          },
        };
      }
    }
  } else repair = true;
  const next = replaceIntent({ resource, intents: record.intents }, intent.intentId, (current) => ({
    ...current,
    state: repair ? "needs-repair" : "settled",
    settledAt,
  }));
  if (
    repair &&
    (outcome.kind === "refusal" || (outcome.kind === "operation" && !outcome.receipt.result.ok))
  )
    next.intents = cancelRefusedLocationChain(next.intents, intent);
  return { expectedRevision: record.resource.revision, next };
}

/** Install a catalog observation acquired after the matching move receipt. */
export function installCanonicalRefresh(input: {
  record: ResourceRecord;
  operationId: string;
  location: ResourceLocation;
}): ResourceWrite | null {
  const obligation = input.record.resource.obligations.canonicalRefresh;
  if (!obligation || obligation.operationId !== input.operationId) return null;
  if (
    input.record.resource.lifecycle.kind === "terminal" ||
    obligation.identityRevision !== input.record.resource.identity.revision
  )
    return null;
  const workScoped = isWorkScopedProjectContextScheme(input.location.scheme);
  // A catalog observation names its Work by id with its slug, null for No Work
  // (`@/`), exactly as catalog installation derives it from the entry's URI.
  // A lineage's Scratch names its first chat instead. Only a Work-scoped
  // location with neither owner is incomplete.
  const owned = input.location.workId != null || input.location.rootThreadId !== undefined;
  if (
    (workScoped && !owned) ||
    (!workScoped && (owned || input.location.workId !== null || input.location.workSlug != null))
  )
    throw new Error("Canonical observation has incomplete Work authority");
  const { canonicalRefresh: _completed, ...obligations } = input.record.resource.obligations;
  return {
    expectedRevision: input.record.resource.revision,
    next: {
      resource: {
        ...input.record.resource,
        revision: input.record.resource.revision + 1,
        canonical: input.location,
        obligations,
      },
      intents: input.record.intents,
    },
  };
}

function replayEligible(
  record: ResourceRecord,
  intent: NamespaceIntent,
  attempt: NamespaceAttempt,
) {
  if (
    record.resource.lifecycle.kind === "terminal" ||
    intent.identityRevision !== record.resource.identity.revision
  )
    return false;
  if (attempt.request.kind === "create")
    return attempt.request.body.documentId === record.resource.identity.documentId;
  return sameSource(record.resource.canonical, attempt.request);
}

/** Reconcile one resource through at most one network dispatch; CAS retries never redispatch. */
export function reconcileResourceNamespace(input: {
  key: { handle: string };
  metadata: ResourceMetadataStore;
  transport: ResourceNamespaceTransport;
  lock: ResourceNamespaceLock;
  newAttemptIds: () => NamespaceAttemptIds;
  now?: () => number;
}): Promise<NamespaceReconcileResult> {
  return reconcileNamespaceJournal({
    ...input,
    read: () => input.metadata.readResource(input.key),
    commit: (write: ResourceWrite) => input.metadata.commitResource(write),
    prepare: prepareNamespaceAttempt,
    recordOutcome: recordNamespaceOutcome,
    settle: (record: ResourceRecord) => settleNamespaceOutcome(record, input.now?.()),
    replayEligible,
  });
}

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
  prepare: (record: Record, ids: NamespaceAttemptIds) => Write | null;
  recordOutcome: (
    record: Record,
    intentId: string,
    attemptId: string,
    outcome: NamespaceOutcome,
  ) => Write | null;
  settle: (record: Record) => Write | null;
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
    const intent = activeNamespaceIntent(record);
    if (!intent) return "idle";
    if (intent.state === "needs-repair") return "needs-repair";
    if (intent.state === "pending") {
      const write = input.prepare(record, input.newAttemptIds());
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
      if (!write) return "idle";
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
