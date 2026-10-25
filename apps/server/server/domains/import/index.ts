/** Upload service composition; organize attaches to the durable queue in the next phase. */
import { IMPORT_SCHEMES } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import type { CollabDomain } from "../collab/index.js";
import {
  type ContextCatalogMutationPort,
  createDrizzleContextImportRead,
  createDrizzleContextParentLocations,
  createDrizzleContextStagedCreation,
  createMammothDocumentConverter,
  type DocumentArrivals,
  type LinkAheadRegistry,
} from "../context/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { ObjectStorePort } from "../storage/index.js";
import { createContextImportTreeWriter } from "./adapters/context-tree-writer.js";
import { createDrizzleImportRepository } from "./adapters/drizzle-import-repository.js";
import { createDrizzleOrganizeQueue } from "./adapters/drizzle-organize-queue.js";
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
  ahead: LinkAheadRegistry;
  arrivals: DocumentArrivals;
  catalog: ContextCatalogMutationPort;
}): ImportOrganizer {
  const internalCause = (cause: unknown) => {
    if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string")
      return { kind: "typed", code: cause.code } as const;
    return {
      kind: "unexpected",
      name: cause instanceof Error ? cause.name : typeof cause,
    } as const;
  };
  return createImportOrganizer({
    db: deps.db,
    repository: createDrizzleImportRepository(deps.db),
    queue: createDrizzleOrganizeQueue(deps.db),
    objects: deps.objects,
    converter: createMammothDocumentConverter(),
    binder: deps.documents.importBinder,
    documents: deps.documents,
    context: (record) => {
      if (!record.projectId) throw new Error("Import project is unavailable");
      return {
        read: createDrizzleContextImportRead(deps.db, record.projectId),
        staged: createDrizzleContextStagedCreation({
          db: deps.db,
          projectId: record.projectId,
          userId: record.userId,
          documents: deps.documents,
          ahead: deps.ahead,
          arrivals: deps.arrivals,
          catalog: deps.catalog,
        }),
      };
    },
    diagnostic: (cause, detail) =>
      emitEvent(deps.eventSink, {
        level: "error",
        source: "import.organize",
        name: "pass.failed",
        payload: {
          ...detail,
          internalCause: internalCause(cause),
          ...unknownToEventPayload(cause),
        },
      }),
  });
}
export function createProductionImportService(
  deps: { db: Database; objects: ObjectStorePort; eventSink: EventSink; wake?: OrganizeWake },
  projectId: string,
  userId: string,
): ImportService {
  return createImportUploadService({
    repository: createDrizzleImportRepository(deps.db),
    objects: deps.objects,
    admission: processAdmission,
    tree: createContextImportTreeWriter(
      createDrizzleContextParentLocations(deps.db, { projectId, userId }, IMPORT_SCHEMES),
    ),
    wake: deps.wake ?? { wake() {} },
    reportError: (cause) =>
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "import.upload",
        name: "activity_failed",
        payload: unknownToEventPayload(cause),
      }),
  });
}
export async function listOpenImports(db: Database, userId: string) {
  const repository = createDrizzleImportRepository(db);
  return queryOpenImports(repository, userId);
}
export function createImportObjectSweeper(db: Database, objects: ObjectStorePort) {
  const repository = createDrizzleImportRepository(db);
  return async () => {
    const result = await sweepImportObjects(repository, objects);
    if (result.failed.length)
      throw new AggregateError(
        result.failed.map((f) => f.cause),
        "Import staging sweep failed",
      );
    return result.swept;
  };
}
