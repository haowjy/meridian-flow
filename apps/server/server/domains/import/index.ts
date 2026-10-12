/** Public import domain composition and service contract. */

import { filetypeForKnownPath, renderFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb, isInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import {
  type CollabDomain,
  createImportLinkBinder,
  type DocumentLinkScopes,
} from "../collab/index.js";
import {
  type ContextCatalogFileMutationPort,
  type ContextCatalogMutationPort,
  createDrizzleContextBulkCreation,
  createDrizzleContextImportLocations,
  createDrizzleDocumentArrivals,
  type LinkAheadRegistry,
  type UnifiedContextPortFactory,
} from "../context/index.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../observability/index.js";
import type { ObjectStorePort } from "../storage/index.js";
import { createContextImportTreeWriter } from "./adapters/context-tree-writer.js";
import { createDrizzleImportRepository } from "./adapters/drizzle-import-repository.js";
import { createMammothDocumentConverter } from "./adapters/mammoth-document-converter.js";
import { createImportService } from "./domain/import-service.js";

import { sweepImportObjects } from "./domain/object-sweep.js";

export { ImportError } from "./domain/manifest.js";
export type ImportService = ReturnType<typeof createImportService>;
export function createProductionImportPorts(
  deps: {
    db: Database;
    collab: CollabDomain;
    contextPorts: UnifiedContextPortFactory;
    catalog: ContextCatalogMutationPort & ContextCatalogFileMutationPort;
    links: DocumentLinkScopes;
    ahead: LinkAheadRegistry;
    objects: ObjectStorePort;
    eventSink: EventSink;
  },
  projectId: string,
  userId: string,
): Parameters<typeof createImportService>[0] {
  const bulk = createDrizzleContextBulkCreation({
    db: deps.db,
    documents: deps.collab,
    recordMembership: () => deps.collab.reconcileProjectManifest(projectId as never),
    arrivals: createDrizzleDocumentArrivals(deps.db, deps.ahead),
    catalog: deps.catalog,
  });
  const binder = createImportLinkBinder({
    codec: mdxCodec({ schema: buildDocumentSchema() }),
    schema: buildDocumentSchema(),
    links: deps.links,
    registrar: deps.ahead,
    inTransaction: isInDrizzleTransaction,
    async resolveFiletype(id) {
      const [row] = await currentDrizzleDb(deps.db)
        .select({ name: documents.name, extension: documents.extension })
        .from(documents)
        .where(eq(documents.id, id));
      return row
        ? (filetypeForKnownPath(renderFilename(row.name, row.extension)) ?? "markdown")
        : null;
    },
  });
  return {
    repository: createDrizzleImportRepository(deps.db),
    converter: createMammothDocumentConverter(),
    objects: deps.objects,
    diagnostics: {
      failed: ({ importId, entryId, code, cause }) =>
        emitEvent(deps.eventSink, {
          level: code === "deleted_before_arrival" ? "debug" : "warn",
          source: "import.landing",
          name: "file_failed",
          correlation: { projectId },
          payload: { importId, entryId, code, ...unknownToEventPayload(cause) },
        }),
    },
    tree: createContextImportTreeWriter({
      db: deps.db,
      locations: createDrizzleContextImportLocations(deps.db, projectId, userId),
      bulk,
      context: deps.contextPorts.forProject(projectId, userId, new Map()),
      collab: deps.collab,
      binder,
      ahead: deps.ahead,
      projectId,
      userId,
      refreshFiles: (ids) => deps.catalog.refreshFiles(ids),
    }),
  };
}

export function createProductionImportService(
  deps: Parameters<typeof createProductionImportPorts>[0],
  projectId: string,
  userId: string,
): ImportService {
  return createImportService(createProductionImportPorts(deps, projectId, userId));
}

export function createImportObjectSweeper(db: Database, objects: ObjectStorePort) {
  const repository = createDrizzleImportRepository(db);
  return () => sweepImportObjects(repository, objects);
}
