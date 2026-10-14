/** Upload service composition; organize attaches to the durable queue in the next phase. */
import type { Database } from "@meridian/database";
import { createDrizzleContextParentLocations } from "../context/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { ObjectStorePort } from "../storage/index.js";
import { createContextImportTreeWriter, IMPORT_AREAS } from "./adapters/context-tree-writer.js";
import { createDrizzleImportRepository } from "./adapters/drizzle-import-repository.js";
import { sweepImportObjects } from "./domain/object-sweep.js";
import { createImportAdmission } from "./domain/receive-admission.js";
import { createImportUploadService, importSummary } from "./domain/upload-service.js";
import type { OrganizeWake } from "./ports/organize-wake.js";

export { IMPORT_LIMITS, ImportError } from "./domain/manifest.js";
export type { ImportPart } from "./domain/receipt.js";

const processAdmission = createImportAdmission();
export type ImportService = ReturnType<typeof createImportUploadService>;
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
      createDrizzleContextParentLocations(deps.db, { projectId, userId }, IMPORT_AREAS),
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
  return Promise.all(
    (await repository.listOpen(userId)).map((record) => importSummary(repository, record)),
  );
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
