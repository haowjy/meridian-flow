/** Upload and organizer composition for the durable two-phase import. */
import { IMPORT_SCHEMES } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { CollabDomain } from "../collab/index.js";
import {
  type ContextImportReveal,
  createDrizzleContextImportDestinationLookup,
  createDrizzleContextImportRead,
} from "../context/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { ObjectStorePort } from "../storage/index.js";
import { createContextImportTreeWriter } from "./adapters/context-tree-writer.js";
import { createDrizzleImportRepository } from "./adapters/drizzle-import-repository.js";
import { createDrizzleOrganizeQueue } from "./adapters/drizzle-organize-queue.js";
import { createMammothDocumentConverter } from "./adapters/mammoth-document-converter.js";
import { sweepImportObjects } from "./domain/object-sweep.js";
import { createImportOrganizer } from "./domain/organize/organizer.js";
import { createImportAdmission } from "./domain/receive-admission.js";
import { createImportUploadService, queryOpenImports } from "./domain/upload-service.js";
import type { OrganizeWake } from "./ports/organize-wake.js";

export { IMPORT_LIMITS, ImportError } from "./domain/manifest.js";
export type { ImportPart } from "./domain/receipt.js";

const processAdmission = createImportAdmission();
export type ImportService = ReturnType<typeof createImportUploadService>;
export type ImportOrganizer = ReturnType<typeof createImportOrganizer>;

export type OrganizeWakeHub = OrganizeWake & { bind(wake: () => void): void };
export function createOrganizeWakeHub(): OrganizeWakeHub {
  let listener: (() => void) | undefined;
  return {
    bind(wake) {
      listener = wake;
    },
    wake() {
      listener?.();
    },
  };
}

export function createProductionImportOrganizer(deps: {
  db: Database;
  objects: ObjectStorePort;
  eventSink: EventSink;
  documents: CollabDomain;
  reveal: ContextImportReveal;
}): ImportOrganizer {
  return createImportOrganizer({
    repository: createDrizzleImportRepository(deps.db),
    queue: createDrizzleOrganizeQueue(deps.db),
    objects: deps.objects,
    converter: createMammothDocumentConverter(),
    binder: deps.documents.importBinder,
    documents: deps.documents,
    read: (record) => {
      if (!record.projectId) throw new Error("Import project is unavailable");
      return createDrizzleContextImportRead(deps.db, record.projectId);
    },
    reveal: deps.reveal,
    previewFailed: (reason) =>
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "import.organize",
        name: "image_preview.failed",
        payload: { reason },
      }),
    diagnostic: (cause, detail) =>
      emitEvent(deps.eventSink, {
        level: "error",
        source: "import.organize",
        name: "pass.failed",
        payload: {
          ...detail,
          ...unknownToEventPayload(cause),
        },
      }),
  });
}
export function createProductionImportService(
  deps: { db: Database; objects: ObjectStorePort; eventSink: EventSink; wake?: OrganizeWake },
  projectId: string,
): ImportService {
  return createImportUploadService({
    repository: createDrizzleImportRepository(deps.db),
    objects: deps.objects,
    admission: processAdmission,
    tree: createContextImportTreeWriter(
      createDrizzleContextImportDestinationLookup(deps.db, projectId, IMPORT_SCHEMES),
    ),
    wake: deps.wake ?? { wake() {} },
    reportError: (cause) =>
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "import.upload",
        name: "activity_failed",
        payload: unknownToEventPayload(cause),
      }),
    previewFailed: (reason) =>
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "import.upload",
        name: "image_preview.failed",
        payload: { reason },
      }),
  });
}
export async function listOpenImports(db: Database, userId: string) {
  const repository = createDrizzleImportRepository(db);
  return queryOpenImports(repository, userId);
}
export function createImportObjectSweeper(
  db: Database,
  objects: ObjectStorePort,
  documents: CollabDomain,
) {
  const repository = createDrizzleImportRepository(db);
  return async () => {
    const result = await sweepImportObjects(repository, objects, {
      journals: {
        discardUnborn: (documentIds) =>
          documents.discardUnbornDocuments(documentIds as DocumentId[]),
      },
    });
    if (result.failed.length)
      throw new AggregateError(
        result.failed.map((f) => f.cause),
        "Import sweep failed",
      );
    return result.swept;
  };
}
