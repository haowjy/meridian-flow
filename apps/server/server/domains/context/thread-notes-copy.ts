/** Live notes preparation and create-only atomic subtree installation for a derived chat. */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import { type ContextNotesLocation, formatParsedContextUri } from "@meridian/contracts/context-uri";
import {
  classifyFiletype,
  type DocumentFileType,
  type Filetype,
  filetypeSchema,
  renderFilename,
} from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { threads, works } from "@meridian/database/schema";
import type { PMNode } from "@meridian/markup";
import { and, eq, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import type { DocumentLinkScopes, MarkdownDocumentStore } from "../collab/index.js";
import type { ObjectRelease, ObjectStorePort } from "../storage/index.js";
import { lockContextNamespaces } from "./adapters/context-fs/document-locations.js";
import { associatedRootForSource } from "./adapters/thread-folders.js";
import { prepareBinaryCopy } from "./binary-copy.js";
import {
  createLineageContextDocumentStore,
  createWorkContextDocumentStore,
} from "./context-source-provisioning.js";
import type { ContextCatalogMutationPort } from "./ports/context-catalog.js";
import type { DocumentArrivals } from "./ports/document-arrivals.js";
import { claimDocumentLocation } from "./tree/node-locations.js";
import { insertDocumentRow, insertFolder, lockDocuments } from "./tree/node-rows.js";
import { createLiveAssociatedRoot } from "./tree/placement.js";
import { readLiveSubtree } from "./tree/read-subtree.js";
import { createTreeReader, LIVE_TREE } from "./tree/tree-view.js";

export interface ThreadNotesCopy {
  copy(input: {
    projectId: string;
    userId: string;
    source: ContextNotesLocation;
    destination: ContextNotesLocation;
    signal: AbortSignal;
    deadline: number;
  }): Promise<"copied" | "skipped">;
}

export function createThreadNotesCopy(deps: {
  db: Database;
  links: DocumentLinkScopes;
  documents: Pick<MarkdownDocumentStore, "readCopySource" | "seedFromNodes">;
  objectStore: ObjectStorePort;
  objects: ObjectRelease;
  arrivals: Pick<DocumentArrivals, "settle">;
  catalog: ContextCatalogMutationPort;
}): ThreadNotesCopy {
  const { db } = deps;
  async function owner(projectId: string, location: ContextNotesLocation) {
    const tx = currentDrizzleDb(db);
    if (location.owner.kind === "work") {
      const [work] = await tx
        .select({ id: works.id })
        .from(works)
        .where(
          and(
            eq(works.projectId, projectId),
            eq(works.slug, location.owner.workSlug),
            eq(works.isNoWork, false),
          ),
        );
      if (!work) throw new Error("Scratch owner is unavailable");
      return { workId: work.id, store: createWorkContextDocumentStore(db, work.id, "scratch") };
    }
    if (location.owner.kind !== "lineage") throw new Error("Thread notes require a Scratch owner");
    const [root] = await tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.projectId, projectId), eq(threads.ref, location.owner.rootThreadRef)));
    if (!root) throw new Error("Scratch lineage is unavailable");
    return { workId: null, store: createLineageContextDocumentStore(db, projectId, root.id) };
  }
  return {
    async copy(input) {
      input.signal.throwIfAborted();
      const source = await owner(input.projectId, input.source);
      const sourceId = await source.store.existingContextSourceId();
      if (!sourceId) return "skipped";
      const tree = createTreeReader(db);
      const root = await tree.resolvePath(LIVE_TREE, {
        contextSourceId: sourceId as ContextSourceId,
        path: `@${input.source.threadRef}`,
      });
      if (root.kind !== "found" || root.node.kind !== "folder") return "skipped";
      const cut = await readLiveSubtree(db, sourceId as ContextSourceId, root.node.folder.id);
      const cutRoot = cut.folders[0];
      if (!cutRoot) return "skipped";
      const destination = await owner(input.projectId, input.destination);
      const existingDestinationId = await destination.store.existingContextSourceId();
      if (existingDestinationId) {
        const existing = await tree.resolvePath(LIVE_TREE, {
          contextSourceId: existingDestinationId as ContextSourceId,
          path: `@${input.destination.threadRef}`,
        });
        if (existing.kind !== "not_found") return "skipped";
      }
      const objects: string[] = [];
      const prepared: ({ id: DocumentId; source: (typeof cut.documents)[number] } & (
        | { kind: "tracked"; filetype: Filetype; nodes: readonly PMNode[]; revision: string }
        | {
            kind: "binary";
            fileType: DocumentFileType;
            binary: { key: string; storageUrl: string; mimeType: string; sizeBytes: number };
            revision: null;
          }
      ))[] = [];
      let installed = false;
      try {
        // Read live content before holding namespace locks: collab pulls on its own connection.
        await deps.links.within(
          { projectId: input.projectId, documentIds: cut.documents.map((document) => document.id) },
          async () => {
            for (const document of cut.documents) {
              input.signal.throwIfAborted();
              const filetype = filetypeSchema.parse(document.fileType);
              const classification = classifyFiletype(filetype);
              if (classification.kind === "binary" || classification.kind === "custom") {
                if (!document.storageUrl)
                  throw new Error(`Binary note ${document.id} has no stored object`);
                const copy = await prepareBinaryCopy(
                  deps.objectStore,
                  {
                    storageUrl: document.storageUrl,
                    mimeType: document.mimeType ?? undefined,
                    uri: `${formatParsedContextUri("scratch", "", input.source.owner, input.source)}${renderFilename(document.name, document.extension)}`,
                  },
                  input.signal,
                  (key) => objects.push(key),
                );
                if (!copy.ok)
                  throw new Error("message" in copy.error ? copy.error.message : copy.error.code);
                prepared.push({
                  id: crypto.randomUUID() as DocumentId,
                  source: document,
                  kind: "binary",
                  fileType: classification.fileType,
                  binary: copy.value,
                  revision: null,
                });
              } else {
                const copy = await deps.documents.readCopySource(document.id, input.signal);
                if (!copy.ok)
                  throw new Error(`Cannot copy notes document ${document.id}: ${copy.error.code}`);
                prepared.push({
                  id: crypto.randomUUID() as DocumentId,
                  source: document,
                  kind: "tracked",
                  filetype,
                  nodes: copy.value.nodes,
                  revision: copy.value.revision,
                });
              }
            }
          },
        );
        // One install is one link-spelling operation, not a fresh scope per note.
        installed = await deps.links.within(
          { projectId: input.projectId, documentIds: prepared.map((copy) => copy.id) },
          () =>
            runInDrizzleTransaction(db, async () => {
              input.signal.throwIfAborted();
              const remaining = Math.max(1, input.deadline - Date.now());
              await currentDrizzleDb(db).execute(
                sql`select set_config('lock_timeout', ${`${remaining}ms`}, true), set_config('statement_timeout', ${`${remaining}ms`}, true)`,
              );
              await lockContextNamespaces(
                db,
                input,
                [{ scheme: "scratch", workId: destination.workId }],
                { sourceIds: [sourceId] },
              );
              if ((await source.store.existingContextSourceId()) !== sourceId)
                throw new Error("Source Scratch is unavailable");
              const destinationId = (await destination.store.contextSourceId()) as ContextSourceId;
              const dir = [`@${input.destination.threadRef}`];
              const existing = await tree.resolvePath(LIVE_TREE, {
                contextSourceId: destinationId,
                path: dir[0] ?? "",
              });
              if (existing.kind !== "not_found") return false;
              const association = await associatedRootForSource(db, destinationId, dir);
              if (!association) throw new Error("Cannot prove copied notes root");
              // A model/writer root wins even if it arrived after preparation. The live
              // (source, thread) unique index arbitrates without destination ownership.
              const rootId = await createLiveAssociatedRoot(db, destinationId, association);
              if (!rootId) return false;
              const folders = new Map<FolderId, FolderId>([[cutRoot.id, rootId]]);
              const paths = new Map<FolderId, string>([[cutRoot.id, ""]]);
              for (const folder of cut.folders.slice(1)) {
                input.signal.throwIfAborted();
                const parentPath = folder.parent_id ? paths.get(folder.parent_id) : undefined;
                if (parentPath === undefined) throw new Error("Copied folder lost its parent");
                const path = [parentPath, folder.name].filter(Boolean).join("/");
                paths.set(folder.id, path);
                const parentId = folder.parent_id ? folders.get(folder.parent_id) : undefined;
                if (!parentId) throw new Error("Copied folder lost its parent");
                const id = await insertFolder(
                  db,
                  { contextSourceId: destinationId, parentId, name: folder.name },
                  { hidden: false },
                );
                await claimDocumentLocation(db, destinationId, parentId, folder.name);
                folders.set(folder.id, id);
              }
              await lockDocuments(
                db,
                prepared.map((copy) => copy.id),
              );
              const created: DocumentId[] = [];
              for (const copy of prepared) {
                input.signal.throwIfAborted();
                const document = copy.source;
                const folderId = document.folderId ? folders.get(document.folderId) : undefined;
                if (!folderId) throw new Error("Copied document lost its parent");
                const copiedFrom = {
                  uri: `${formatParsedContextUri("scratch", "", input.source.owner, input.source)}${[document.folderId ? paths.get(document.folderId) : undefined, renderFilename(document.name, document.extension)].filter(Boolean).join("/")}`,
                  version: "live" as const,
                  revision: copy.revision,
                };
                const id = await insertDocumentRow(
                  db,
                  {
                    contextSourceId: destinationId,
                    folderId,
                    name: document.name,
                    extension: document.extension,
                  },
                  copy.kind === "binary"
                    ? {
                        kind: "binary",
                        fileType: copy.fileType,
                        ...copy.binary,
                        metadata: { copiedFrom },
                      }
                    : {
                        kind: "tracked",
                        filetype: copy.filetype,
                        metadata: { copiedFrom },
                      },
                  { hidden: false, id: copy.id },
                );
                if (!id) throw new Error("Copied document location is occupied");
                if (copy.kind === "tracked") await deps.documents.seedFromNodes(id, copy.nodes);
                created.push(id);
              }
              await deps.arrivals.settle(created);
              await deps.catalog.refreshSources([destinationId]);
              return true;
            }),
        );
        return installed ? "copied" : "skipped";
      } finally {
        if (!installed) await deps.objects.keys(objects, input.signal);
      }
    },
  };
}
