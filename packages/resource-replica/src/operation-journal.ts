/**
 * The journal of an operation that spans several records (a Copy): one record per operation id,
 * holding the operation's own intents and attempts. It is the third journal kind beside a
 * resource's and a folder's, and it rides the same generic replay (`reconcileNamespaceJournal`),
 * placement admission and predecessor gate.
 *
 * A Copy is sent under its own operation id and no other, so one id keys its replay, its receipt,
 * its roots' refresh barriers and its retention. The answer moves the roots in the same
 * transaction that records it: a receipt places each of them, a refusal drops them.
 */
import type { CatalogFileClassification } from "@meridian/contracts/protocol";
import { newCopyRootRecord } from "./copy-roots";
import { settleNamespaceIntent, validateNamespaceJournal } from "./namespace-journal-policy";
import { NAMESPACE_RECEIPT_NOTE_TTL_MS, namespaceReceiptIs } from "./namespace-receipts";
import { placementUnresolved, refreshBarrierOperationIds } from "./placement-journal";
import { namespaceIntentOutcome } from "./resource-intent-policy";
import {
  activeNamespaceIntent,
  displayedPath,
  type NamespaceGate,
  type NamespaceReconcileResult,
  namespaceAttemptWithOutcome,
  namespaceOutcomeMatches,
  reconcileNamespaceJournal,
} from "./resource-namespace";
import {
  type CopyDesired,
  type CopyRoot,
  destinationParentLocation,
  type FolderNamespaceRecord,
  type MetadataCommitResult,
  type NamespaceIntent,
  type NamespaceOutcome,
  type NamespaceRequest,
  namespaceRequestId,
  type OperationReader,
  type OperationRecord,
  type OperationWrite,
  ownerOf,
  type PlacementAdmission,
  type ResourceLocation,
  type ResourceNamespaceLock,
  type ResourceNamespaceTransport,
  type ResourceRecord,
  type RootPlace,
  SourceBehindError,
} from "./resource-records";
import { moveOwnerFields } from "./resource-work-authority";

/** Browser persistence implements this beside its file and folder journals, in the same account owner. */
export interface OperationStore extends OperationReader {
  readonly accountId: string;
  commitOperation(write: OperationWrite): Promise<MetadataCommitResult>;
  /** Drops a retired operation; stale when it changed since `revision` was read. */
  retireOperation(operationId: string, revision: number): Promise<MetadataCommitResult>;
}

/** How long a Copy keeps resending while the server says its source room has not caught up. */
export const SOURCE_BEHIND_BOUND_MS = 120_000;

export function validateOperationRecordUpdate(
  previous: OperationRecord | null,
  next: OperationRecord,
): void {
  if (next.revision !== (previous?.revision ?? 0) + 1)
    throw new Error("Invalid operation revision");
  if (
    previous &&
    (next.operationId !== previous.operationId || next.projectId !== previous.projectId)
  )
    throw new Error("Operation identity mismatch");
  if (
    next.intents.some(
      (intent) =>
        intent.projectId !== next.projectId ||
        intent.identityRevision !== 1 ||
        intent.desired.kind !== "copy",
    )
  )
    throw new Error("Operation journal only admits Copy intents of its project");
  // The id keys the replay, the receipt, the roots' barriers and retention: nothing is sent under another.
  if (
    next.intents.some((intent) =>
      intent.attempts.some(
        ({ request }) => request.kind !== "copy" || request.body.operationId !== next.operationId,
      ),
    )
  )
    throw new Error("An operation is sent only under its own id");
  validateNamespaceJournal({
    previous: previous && { handle: previous.operationId, intents: previous.intents },
    next: { handle: next.operationId, intents: next.intents },
    identityRevision: 1,
  });
}

/** Work that can progress without a new writer command, as `folderNeedsBackgroundReconciliation` for folders. */
export function operationNeedsBackgroundReconciliation(record: OperationRecord): boolean {
  return record.intents.some((intent) => placementUnresolved(intent.state));
}

/**
 * A Copy as the writer asked for it: the operation, and a root record for every selected entry.
 * `roots` holds the outermost selection only (a root inside another is carried by it), so every id
 * minted here comes back in the receipt.
 */
export function planCopy(input: {
  projectId: string;
  operationId: string;
  intentId: string;
  admission: PlacementAdmission;
  /** The destination's scheme: an account-owned `user` folder belongs to no project. */
  scheme: string;
  roots: readonly (CopyRoot & { classification: CatalogFileClassification | null })[];
  destination: CopyDesired["destination"];
}): OperationWrite {
  const { projectId, operationId } = input;
  const records = input.roots.map((root) =>
    newCopyRootRecord({ operationId, projectId }, root, input.scheme, root.classification),
  );
  return {
    expectedRevision: null,
    next: {
      operationId,
      projectId,
      revision: 1,
      intents: [
        {
          projectId,
          handle: operationId,
          intentId: input.intentId,
          operationId,
          sequence: 1,
          admission: input.admission,
          identityRevision: 1,
          desired: {
            kind: "copy",
            roots: input.roots.map(({ classification: _, ...root }) => root),
            destination: input.destination,
          },
          attempts: [],
          state: "pending",
        },
      ],
    },
    roots: {
      created: {
        resources: records.flatMap((record) => ("resource" in record ? [record.resource] : [])),
        folders: records.flatMap((record) => ("folder" in record ? [record.folder] : [])),
      },
    },
  };
}

function replaceIntent(
  record: OperationRecord,
  intentId: string,
  replace: (intent: NamespaceIntent) => NamespaceIntent,
): OperationWrite {
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

/** The roots' records leave with a Copy that did not happen. */
function refusal(record: OperationRecord, intent: NamespaceIntent, copy: CopyDesired) {
  return {
    ...replaceIntent(record, intent.intentId, (current) => ({ ...current, state: "needs-repair" })),
    roots: { dropped: copy.roots.map((root) => root.handle) },
  } satisfies OperationWrite;
}

function pathParts(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Persists the Copy's request before the transport sees it. Sources are found by identity, at the
 * place the server holds them now; a source or a destination that is gone is a refusal the writer
 * repairs, sent nowhere. Null while a source's place is not settled (a pending move of it).
 */
export async function prepareCopyAttempt(
  record: OperationRecord,
  attemptId: string,
  transport: Pick<ResourceNamespaceTransport, "lookupIdentity">,
): Promise<OperationWrite | null> {
  const intent = activeNamespaceIntent(record);
  if (intent?.state !== "pending" || intent.desired.kind !== "copy") return null;
  const copy = intent.desired;
  const { parent, position } = copy.destination;
  const [destination, ...sources] = await Promise.all([
    parent.kind === "folder"
      ? transport.lookupIdentity(record.projectId, { kind: "folder", id: parent.folderId })
      : null,
    ...copy.roots.map((root) =>
      transport.lookupIdentity(record.projectId, { kind: root.kind, id: root.sourceId }),
    ),
  ]);
  const parentLocation = destinationParentLocation(parent, () =>
    destination?.kind === "available" ? destination.location : null,
  );
  const places = sources.flatMap((source) =>
    source.kind === "available" ? [source.location] : [],
  );
  if (!parentLocation || places.length !== sources.length) return refusal(record, intent, copy);
  const request: Extract<NamespaceRequest, { kind: "copy" }> = {
    kind: "copy",
    owner: ownerOf(parentLocation),
    body: {
      operationId: record.operationId,
      sources: copy.roots.map((root, index) => {
        const source = places[index] as ResourceLocation;
        const { body: owners } = moveOwnerFields(source, parentLocation);
        return {
          scheme: source.scheme,
          path: pathParts(source.path),
          expected: { kind: root.kind, nodeId: root.sourceId },
          workId: owners.sourceWorkId,
          rootThreadId: owners.sourceRootThreadId,
          ...(source.chatRef ? { chatRef: source.chatRef } : {}),
          view: root.view,
          copyId: root.copyId,
          ...(root.stateVector ? { stateVector: root.stateVector } : {}),
        };
      }),
      destinationScheme: parentLocation.scheme,
      destinationFolderPath: pathParts(parentLocation.path),
      destinationWorkId: parentLocation.workId,
      destinationRootThreadId: parentLocation.rootThreadId ?? null,
      destinationParent: parent,
      ...(position ? { position } : {}),
    },
  };
  return replaceIntent(record, intent.intentId, (current) => ({
    ...current,
    state: "submitted",
    attempts: [...current.attempts, { attemptId, request }],
  }));
}

/** Records transport evidence against the attempt it answers; the roots wait for `settleCopy`. */
export function recordCopyOutcome(
  record: OperationRecord,
  intentId: string,
  attemptId: string,
  outcome: NamespaceOutcome,
): OperationWrite | null {
  const intent = record.intents.find((candidate) => candidate.intentId === intentId);
  const attempt = intent?.attempts.at(-1);
  if (!intent || !attempt || attempt.attemptId !== attemptId)
    throw new Error("Namespace attempt is no longer current");
  if (attempt.outcome) return null;
  if (intent.state !== "submitted" || !namespaceOutcomeMatches(attempt, outcome))
    throw new Error("Namespace outcome does not match current attempt");
  const answered = namespaceAttemptWithOutcome(attempt, outcome);
  return replaceIntent(record, intentId, (current) => ({
    ...current,
    state: "received",
    attempts: current.attempts.map((candidate) =>
      candidate.attemptId === attemptId ? answered : candidate,
    ),
  }));
}

/**
 * Applies the recorded answer to the roots in the transaction that settles the operation: a
 * receipt gives each its place, anything else drops them. A root the receipt does not name is a
 * contract violation, not a refusal.
 */
export function settleCopy(record: OperationRecord, settledAt = Date.now()): OperationWrite | null {
  const intent = activeNamespaceIntent(record);
  const attempt = intent?.attempts.at(-1);
  const outcome = attempt?.outcome;
  if (
    intent?.state !== "received" ||
    intent.desired.kind !== "copy" ||
    attempt?.request.kind !== "copy" ||
    !outcome
  )
    return null;
  const copy = intent.desired;
  const disposition = namespaceIntentOutcome(outcome);
  const settled = {
    expectedRevision: record.revision,
    next: {
      ...record,
      revision: record.revision + 1,
      intents: settleNamespaceIntent(record.intents, intent, disposition, settledAt, "uncertain"),
    },
  };
  if (disposition !== "accepted")
    return { ...settled, roots: { dropped: copy.roots.map((root) => root.handle) } };
  const { request } = attempt;
  const receipt = outcome.kind === "operation" ? outcome.receipt : null;
  const entries =
    receipt && namespaceReceiptIs(receipt, "copy") && receipt.result.ok
      ? receipt.result.value.entries
      : null;
  if (!receipt || !entries) throw new Error("An accepted Copy answers with its receipt");
  const places = copy.roots.map((root): RootPlace => {
    const entry = entries.find((candidate) => candidate.id === root.copyId);
    if (!entry || entry.kind !== root.kind)
      throw new Error("A Copy receipt must name every root it was asked to copy");
    return {
      handle: root.handle,
      kind: root.kind,
      location: {
        scheme: request.body.destinationScheme,
        path: displayedPath(entry.path),
        name: entry.name,
        ...request.owner,
      },
      parent: copy.destination.parent,
      observationVersion: receipt.observationVersion,
    };
  });
  return { ...settled, roots: { placed: places } };
}

/**
 * Reconciles one operation through the generic journal replay. An operation waits behind its
 * predecessors, is sent under its own operation id, and settles its roots with its answer. A
 * source room that has not caught up is resent for `SOURCE_BEHIND_BOUND_MS`, then refused: a
 * Copy that never ends would hold its admission keys for ever.
 */
export function reconcileOperationNamespace(input: {
  /** The operation's handle: its operation id. */
  key: { handle: string };
  metadata: OperationStore;
  transport: ResourceNamespaceTransport;
  lock: ResourceNamespaceLock;
  newAttemptId: () => string;
  gate?: NamespaceGate;
  now?: () => number;
}): Promise<NamespaceReconcileResult> {
  const { metadata, key } = input;
  const now = input.now ?? Date.now;
  const transport: ResourceNamespaceTransport = {
    ...input.transport,
    submit: async (projectId, request) => {
      try {
        return await input.transport.submit(projectId, request);
      } catch (error) {
        if (!(error instanceof SourceBehindError)) throw error;
        const record = await metadata.readOperation(key.handle);
        if (!record) throw error;
        const since = record.behindSince ?? now();
        if (now() - since < SOURCE_BEHIND_BOUND_MS) {
          if (record.behindSince === undefined)
            await metadata.commitOperation({
              expectedRevision: record.revision,
              next: { ...record, revision: record.revision + 1, behindSince: since },
            });
          return null;
        }
        // The server recorded nothing, so giving up is the writer's to retry as a new Copy.
        return {
          kind: "refusal",
          operationId: namespaceRequestId(request),
          error: { ...error.error, retryable: false },
        };
      }
    },
  };
  return reconcileNamespaceJournal({
    key,
    metadata,
    transport,
    lock: input.lock,
    gate: input.gate,
    // An operation is sent under its own id, whatever id the loop would mint.
    newAttemptIds: () => ({ attemptId: input.newAttemptId(), operationId: key.handle }),
    read: () => metadata.readOperation(key.handle),
    commit: (write: OperationWrite) => metadata.commitOperation(write),
    prepare: (record, ids) => prepareCopyAttempt(record, ids.attemptId, transport),
    repair: (record, intentId) => {
      const intent = record.intents.find((candidate) => candidate.intentId === intentId);
      if (intent?.desired.kind !== "copy") throw new Error("Only a Copy can be repaired");
      return refusal(record, intent, intent.desired);
    },
    recordOutcome: recordCopyOutcome,
    settle: (record) => settleCopy(record, now()),
    refresh: async () => null,
    replayEligible: (_record, intent, attempt) =>
      intent.desired.kind === "copy" && attempt.request.kind === "copy",
  });
}

/** The writer is done with a refused Copy: it dismisses it or sends it again (a new Copy). */
export function resolveRefusedCopy(record: OperationRecord): OperationWrite | null {
  const refused = record.intents.filter((intent) => intent.state === "needs-repair");
  if (refused.length === 0) return null;
  return {
    expectedRevision: record.revision,
    next: {
      ...record,
      revision: record.revision + 1,
      intents: record.intents.map((intent) =>
        intent.state === "needs-repair" ? { ...intent, state: "superseded" } : intent,
      ),
    },
  };
}

/**
 * The operations whose records have nothing left to say, for the caller to drop. Every projection
 * emit reads the whole store, so a record that is never dropped makes each emit slower as history
 * grows. An operation stays while it has unresolved work, while it `needs-repair` (a refusal
 * outlives a reload until the writer resolves it), while a root still waits on its answer, while
 * a root's refresh barrier names it, and for a short grace after it settles. The issuing tab's
 * notice keeps its own copy of the answer, so nothing waits on the record past that. A superseded
 * or cancelled one retires at once: nothing shows it.
 */
export function retiredOperations(
  snapshot: {
    records: readonly ResourceRecord[];
    folders: readonly FolderNamespaceRecord[];
    operations: readonly OperationRecord[];
  },
  now: number,
): OperationRecord[] {
  if (snapshot.operations.length === 0) return [];
  const held = refreshBarrierOperationIds(snapshot);
  for (const { resource } of snapshot.records)
    if (resource.copiedBy && resource.serverHold === "uncertain")
      held.add(resource.copiedBy.operationId);
  for (const folder of snapshot.folders)
    if (folder.copiedBy && folder.serverHold === "uncertain") held.add(folder.copiedBy.operationId);
  return snapshot.operations.filter(
    (operation) =>
      !held.has(operation.operationId) &&
      operation.intents.every((intent) => {
        switch (intent.state) {
          case "settled":
            return (
              intent.settledAt !== undefined &&
              now >= intent.settledAt + NAMESPACE_RECEIPT_NOTE_TTL_MS
            );
          case "cancelled":
          case "superseded":
            return true;
          default:
            return false;
        }
      }),
  );
}
