import type {
  DocumentId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  projects,
  threadDocuments,
  threads,
  threadWorks,
  works,
} from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import type { DocumentSyncService } from "../collab/index.js";
import {
  createInMemoryProjectContextPortFactory,
  createProductionProjectContextPortFactory,
} from "./context-port-factory.js";

const WORK_SCHEME = "work:";
const MANUSCRIPT_SOURCE = "manuscript";
const CHAPTER_ONE_PATH = "chapter-1.md";

export type ContextDocument = {
  documentId: DocumentId;
  uri: string;
  markdown: string;
};

export type ContextPort = {
  readDocument(uri: string): Promise<ContextDocument>;
  writeDocument(input: {
    uri: string;
    markdown: string;
    origin: { type: "agent"; actorTurnId: TurnId } | { type: "user"; actorUserId: UserId };
  }): Promise<ContextDocument & { updateSeq: number }>;
  editDocument(input: {
    uri: string;
    transform: (markdown: string) => string;
    origin: { type: "agent"; actorTurnId: TurnId } | { type: "user"; actorUserId: UserId };
  }): Promise<ContextDocument & { updateSeq: number; beforeMarkdown: string }>;
};

export type ContextPortFactory = {
  forThread(input: { threadId: ThreadId; userId: UserId }): ContextPort;
  forProject(projectId: string, userId: string): import("./ports/context-port.js").ContextPort;
};

function parseWorkUri(uri: string): { source: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new HTTPError({ status: 400, message: "Context URI must be work://..." });
  }

  const path = parsed.pathname.replace(/^\/+/, "");
  if (
    parsed.protocol !== WORK_SCHEME ||
    parsed.hostname !== MANUSCRIPT_SOURCE ||
    path !== CHAPTER_ONE_PATH
  ) {
    throw new HTTPError({
      status: 400,
      message: "Phase 4 supports only work://manuscript/chapter-1.md",
    });
  }

  return { source: parsed.hostname, path };
}

export function createInMemoryContextPortFactory(): ContextPortFactory {
  const projectPorts = createInMemoryProjectContextPortFactory();
  return {
    forProject: projectPorts.forProject,
    forThread() {
      return {
        async readDocument() {
          throw new Error("in-memory context port is not implemented");
        },
        async writeDocument() {
          throw new Error("in-memory context port is not implemented");
        },
        async editDocument() {
          throw new Error("in-memory context port is not implemented");
        },
      };
    },
  };
}

export function createProductionContextPortFactory(deps: {
  db: Database;
  documentSync: DocumentSyncService;
}): ContextPortFactory {
  const projectPorts = createProductionProjectContextPortFactory(deps);
  async function resolveThreadScope(
    threadId: ThreadId,
    userId: UserId,
  ): Promise<{ projectId: ProjectId; workId: WorkId }> {
    const [thread] = await deps.db
      .select({
        projectId: threads.projectId,
        workId: threadWorks.workId,
      })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .innerJoin(
        threadWorks,
        and(eq(threadWorks.threadId, threads.id), eq(threadWorks.isPrimary, true)),
      )
      .innerJoin(works, eq(works.id, threadWorks.workId))
      .where(
        and(
          eq(threads.id, threadId),
          eq(projects.userId, userId),
          eq(works.createdByUserId, userId),
          isNull(threads.deletedAt),
          isNull(projects.deletedAt),
          isNull(works.deletedAt),
        ),
      )
      .limit(1);
    if (!thread?.workId) throw new HTTPError({ status: 404, message: "Thread not found" });
    return { projectId: thread.projectId, workId: thread.workId };
  }

  async function resolveDocument(threadId: ThreadId, userId: UserId, uri: string) {
    const parsed = parseWorkUri(uri);
    const { projectId } = await resolveThreadScope(threadId, userId);

    const [document] = await deps.db
      .select({
        documentId: documents.id,
        markdown: documents.markdownProjection,
      })
      .from(documents)
      .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
      .innerJoin(threadDocuments, eq(threadDocuments.documentId, documents.id))
      .where(
        and(
          eq(contextSources.projectId, projectId),
          isNull(contextSources.workId),
          eq(contextSources.slug, parsed.source),
          eq(documents.name, "chapter-1"),
          eq(documents.extension, "md"),
          eq(threadDocuments.threadId, threadId),
          eq(threadDocuments.relationship, "editing"),
          isNull(contextSources.deletedAt),
          isNull(documents.deletedAt),
        ),
      )
      .limit(1);

    if (!document) throw new HTTPError({ status: 404, message: "Document not found" });
    return document;
  }

  return {
    forProject: projectPorts.forProject,
    forThread(input) {
      return {
        async readDocument(uri) {
          const document = await resolveDocument(input.threadId, input.userId, uri);
          return { documentId: document.documentId, uri, markdown: document.markdown };
        },

        async writeDocument(write) {
          const document = await resolveDocument(input.threadId, input.userId, write.uri);
          const result = await deps.documentSync.writeDocument({
            documentId: document.documentId,
            threadId: input.threadId,
            markdown: write.markdown,
            origin: write.origin,
          });
          return {
            documentId: document.documentId,
            uri: write.uri,
            markdown: result.markdown,
            updateSeq: result.updateSeq,
          };
        },

        async editDocument(edit) {
          const document = await resolveDocument(input.threadId, input.userId, edit.uri);
          const result = await deps.documentSync.editDocument({
            documentId: document.documentId,
            threadId: input.threadId,
            transform: edit.transform,
            origin: edit.origin,
          });
          return {
            documentId: document.documentId,
            uri: edit.uri,
            beforeMarkdown: result.beforeMarkdown,
            markdown: result.markdown,
            updateSeq: result.updateSeq,
          };
        },
      };
    },
  };
}

export { ContextFS } from "./adapters/context-fs/context-fs.js";
export {
  DrizzleContextDocumentStore,
  updateDocumentProjectionById,
} from "./adapters/context-fs/drizzle-store.js";
export { InMemoryContextDocumentStore } from "./adapters/context-fs/in-memory-store.js";
export { firstLineMatch } from "./adapters/context-fs/match.js";
export { joinPath, parseFilename, renderFilename, splitPath } from "./context/paths.js";
export { createContextPortRouter } from "./context/router.js";
export {
  parseContextUri,
  parseUnifiedContextUri,
  toCanonical,
  UNIFIED_CONTEXT_SCHEMES,
} from "./context/uri.js";
export {
  createInMemoryProjectContextPortFactory,
  createProductionProjectContextPortFactory,
} from "./context-port-factory.js";
export {
  contextPortForProjectBrowse,
  contextPortForThread,
  resolveThreadContext,
} from "./context-port-resolution.js";
export {
  createProjectContextDocumentStore,
  createWorkContextDocumentStore,
} from "./context-source-provisioning.js";
export * from "./corpus-import/index.js";
export * from "./figures/index.js";
export * from "./input-ingest/input-ingest-service.js";
export * from "./input-ingest/run-input-paths.js";
export type {
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterSearchHit,
  ContextSchemeAdapter,
  SchemeCapabilities,
} from "./ports/context-adapter.js";
export type {
  ContextDocumentStore,
  ContextFolder,
  ContextSearchRow,
  CreateBinaryDocumentInput,
  UpsertDocumentInput,
} from "./ports/context-document-store.js";
export type {
  BinaryFileEntry,
  BinaryFileRef,
  ContextError,
  ContextFileEntry,
  ContextListEntry,
  ContextReadResult,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  DirectoryEntry,
  EditableFileEntry,
  FileEntry,
  FileRef,
  ProjectContextFsScheme,
  SearchResult,
  TrackedFileRef,
  WorkScopedContextFsScheme,
  WriteProvenance,
} from "./ports/context-port.js";
export { createDrizzleResultRepository } from "./promotion/adapters/drizzle-result-repository.js";
export { createInMemoryResultRepository } from "./promotion/adapters/in-memory-result-repository.js";
export { createCheckpointArtifactFlush } from "./promotion/checkpoint-artifact-flush.js";
export {
  type CheckpointFlushManifest,
  type CheckpointFlushManifestEntry,
  type CheckpointFlushService,
  createCheckpointFlushService,
  sourcePathsFromArtifactRefs,
} from "./promotion/checkpoint-flush.js";
export type {
  CreateProjectResultInput,
  ProjectResultRecord,
  ResultRepository,
} from "./promotion/ports/result-repository.js";
export { evaluatePromotionPolicy, PROMOTION_POLICY_TABLE } from "./promotion/promotion-policy.js";
export {
  createPromotionService,
  type PromotedArtifact,
  type PromotionService,
} from "./promotion/promotion-service.js";
export type { ResultProvenance } from "./promotion/result-provenance.js";
export {
  createInMemoryUnifiedContextPortFactory,
  createProductionUnifiedContextPortFactory,
  type UnifiedContextPortFactory,
} from "./unified-context-port-factory.js";
export * from "./uploads/index.js";
