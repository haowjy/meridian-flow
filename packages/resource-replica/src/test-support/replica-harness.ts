/**
 * In-memory device replica for tests across tiers. Every write passes the storage adapters'
 * validators, and a folder's delete settlement terminalizes its receipt's exact documents in
 * the same commit, as the browser account owner does.
 */
import type { CatalogSnapshot, ContextOperationReceipt } from "@meridian/contracts/protocol";
import { catalogViewFromSnapshot } from "../catalog";
import { catalogObservationFence } from "../catalog-acquisition";
import { type CatalogObservationFence, planCatalogInstallation } from "../catalog-installation";
import { planFolderCatalogInstallation } from "../folder-catalog-installation";
import {
  folderDeletionSettlement,
  planFolderDeletion,
  planFolderDeletionResources,
  prepareFolderNamespaceAttempt,
  recordFolderNamespaceOutcome,
  settleFolderNamespaceOutcome,
  validateFolderNamespaceUpdate,
} from "../folder-namespace";
import { createResourcePlacement } from "../folder-projection";
import { planResourceDeletion } from "../resource-deletion";
import {
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "../resource-namespace";
import type {
  FolderNamespaceRecord,
  FolderNamespaceWrite,
  NamespaceRequest,
  ResourceCatalogCheckpoint,
  ResourceProjectionSnapshot,
  ResourceRecord,
  ResourceWrite,
} from "../resource-records";
import { validateResourceRecordUpdate } from "../resource-records-policy";

type DeleteRequest = Extract<NamespaceRequest, { kind: "delete" }>;

export class ReplicaHarness {
  readonly records = new Map<string, ResourceRecord>();
  readonly folders = new Map<string, FolderNamespaceRecord>();
  private checkpoint: ResourceCatalogCheckpoint | null = null;
  private sequence = 0;

  constructor(readonly projectId: string) {}

  snapshot(): ResourceProjectionSnapshot {
    return structuredClone({
      records: [...this.records.values()],
      folders: [...this.folders.values()],
      operations: [],
      catalogs: this.checkpoint ? [this.checkpoint] : [],
    });
  }

  /** What a catalog request captures before HTTP. */
  fence(): CatalogObservationFence {
    return catalogObservationFence(this.snapshot());
  }

  /** Install one catalog response atomically, against the fence its request captured. */
  install(response: CatalogSnapshot, fence: CatalogObservationFence = this.fence()): void {
    const view = catalogViewFromSnapshot(response);
    const snapshot = this.snapshot();
    const plan = planCatalogInstallation({
      projectId: this.projectId,
      records: snapshot.records,
      view,
      previous: this.checkpoint,
      observedAfter: fence,
    });
    const folders = planFolderCatalogInstallation({
      projectId: this.projectId,
      folders: snapshot.folders,
      view,
      fence,
    });
    for (const write of plan.resources) this.commitResource(write);
    for (const write of folders) this.commitFolder(write);
    this.checkpoint = plan.checkpoint;
  }

  commitResource(write: ResourceWrite): void {
    const previous = this.records.get(write.next.resource.handle) ?? null;
    if ((previous?.resource.revision ?? null) !== write.expectedRevision)
      throw new Error("Stale resource write");
    validateResourceRecordUpdate(previous, write.next);
    this.records.set(write.next.resource.handle, structuredClone(write.next));
  }

  commitFolder(write: FolderNamespaceWrite): void {
    const previous = this.folders.get(write.next.handle) ?? null;
    if ((previous?.revision ?? null) !== write.expectedRevision)
      throw new Error("Stale folder write");
    validateFolderNamespaceUpdate(previous, write.next);
    const receipt = folderDeletionSettlement(previous, write.next);
    if (receipt)
      for (const descendant of planFolderDeletionResources(receipt, [...this.records.values()]))
        this.commitResource(descendant);
    this.folders.set(write.next.handle, structuredClone(write.next));
  }

  folder(folderId: string): FolderNamespaceRecord {
    const record = [...this.folders.values()].find((folder) => folder.folderId === folderId);
    if (!record) throw new Error(`Unknown folder ${folderId}`);
    return record;
  }

  document(documentId: string): ResourceRecord {
    const record = [...this.records.values()].find(
      ({ resource }) => resource.identity.documentId === documentId,
    );
    if (!record) throw new Error(`Unknown document ${documentId}`);
    return record;
  }

  /** The writer deletes a known folder; returns the immutable request the server must answer. */
  requestFolderDeletion(folderId: string): DeleteRequest {
    const record = this.folder(folderId);
    const id = ++this.sequence;
    const operationId = crypto.randomUUID();
    const planned = planFolderDeletion({
      record,
      projectId: this.projectId,
      handle: record.handle,
      folderId,
      source: record.canonical ?? undefined,
      intentId: `folder-delete-${id}`,
      operationId,
    });
    if (!planned) throw new Error("Folder deletion was not admitted");
    this.commitFolder(planned);
    const prepared = prepareFolderNamespaceAttempt(planned.next, {
      attemptId: `attempt-${id}`,
      operationId,
    });
    if (!prepared) throw new Error("Folder deletion was not prepared");
    this.commitFolder(prepared);
    const request = prepared.next.intents.at(-1)?.attempts.at(-1)?.request;
    if (request?.kind !== "delete") throw new Error("Missing folder delete request");
    return request;
  }

  /** The server's receipt for the folder's submitted delete settles it, descendants included. */
  settleFolderDeletion(folderId: string, receipt: ContextOperationReceipt): void {
    const record = this.folder(folderId);
    const intent = record.intents.find((candidate) => candidate.state === "submitted");
    const attempt = intent?.attempts.at(-1);
    if (!intent || !attempt) throw new Error("No submitted folder deletion");
    const received = recordFolderNamespaceOutcome(record, intent.intentId, attempt.attemptId, {
      kind: "operation",
      receipt,
    });
    if (!received) throw new Error("Folder outcome was not recorded");
    this.commitFolder(received);
    const settled = settleFolderNamespaceOutcome(received.next, 1);
    if (!settled) throw new Error("Folder deletion did not settle");
    this.commitFolder(settled);
  }

  requestDocumentDeletion(documentId: string): DeleteRequest {
    const id = ++this.sequence;
    const planned = planResourceDeletion(
      this.document(documentId),
      this.projectId,
      `document-delete-${id}`,
    );
    if (!planned) throw new Error("Document deletion was not admitted");
    this.commitResource(planned);
    const prepared = prepareNamespaceAttempt(planned.next, {
      attemptId: `attempt-${id}`,
      operationId: crypto.randomUUID(),
    });
    if (!prepared) throw new Error("Document deletion was not prepared");
    this.commitResource(prepared);
    const request = prepared.next.intents.at(-1)?.attempts.at(-1)?.request;
    if (request?.kind !== "delete") throw new Error("Missing document delete request");
    return request;
  }

  settleDocumentDeletion(documentId: string, receipt: ContextOperationReceipt): void {
    const record = this.document(documentId);
    const intent = record.intents.find((candidate) => candidate.state === "submitted");
    const attempt = intent?.attempts.at(-1);
    if (!intent || !attempt) throw new Error("No submitted document deletion");
    const received = recordNamespaceOutcome(record, intent.intentId, attempt.attemptId, {
      kind: "operation",
      receipt,
    });
    if (!received) throw new Error("Document outcome was not recorded");
    this.commitResource(received);
    const settled = settleNamespaceOutcome(received.next, 1);
    if (!settled) throw new Error("Document deletion did not settle");
    this.commitResource(settled);
  }

  /** The tree the writer sees: projected catalog row ids, and one document's projected home. */
  projection() {
    const snapshot = this.snapshot();
    const entries = snapshot.catalogs.flatMap((catalog) => catalog.entries);
    const placement = createResourcePlacement(this.projectId, entries, snapshot.folders);
    return {
      ids: placement
        .projectCatalog(entries, snapshot.records)
        .filter((entry) => entry.kind !== "source")
        .map((entry) => entry.entryId)
        .sort(),
      location: (documentId: string) => placement.resourceLocation(this.document(documentId)),
    };
  }
}
