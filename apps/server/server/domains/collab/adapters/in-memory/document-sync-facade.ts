/**
 * In-memory DocumentSyncFacade: wraps the inner DocumentSyncService with the
 * same mutex-guarded writeDocument/editDocument surface as the Drizzle facade
 * so unified context ports exercise atomic collab edits in tests.
 */
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { HTTPError } from "nitro/h3";
import { KeyedMutex } from "../../../../shared/keyed-mutex.js";
import {
  createDocumentSyncService as createInnerDocumentSyncService,
  type DocumentSyncServiceOptions,
  type DocumentSyncService as InnerDocumentSyncService,
} from "../../domain/document-sync-service.js";
import type { DocumentSyncFacade, DocumentWriteOrigin, DocumentWriteResult } from "../../index.js";
import type { DocumentStore } from "../../ports/document-store.js";
import type { PersistedUpdate, SyncError, UpdateOrigin } from "../../ports/document-sync.js";
import { createInMemoryDocumentStore } from "./document-store.js";

export type InMemoryDocumentProjection = {
  markdown: string;
  filetype: string;
};

function toUpdateOrigin(origin: DocumentWriteOrigin): UpdateOrigin {
  if (origin.type === "agent") {
    return { type: "agent", actorTurnId: origin.actorTurnId };
  }
  return { type: "user", userId: origin.actorUserId };
}

function syncErrorToHttp(error: SyncError): HTTPError {
  switch (error.code) {
    case "not_found":
      return new HTTPError({ status: 404, message: "Document not found" });
    case "edit_not_found":
      return new HTTPError({ status: 409, message: "Edit target not found in document" });
    case "ambiguous_edit":
      return new HTTPError({ status: 409, message: "Edit target is ambiguous in document" });
    case "corrupt_state":
      return new HTTPError({ status: 500, message: error.message });
    default:
      return new HTTPError({ status: 500, message: "Document sync failed" });
  }
}

async function resolveWriteUpdateResult(
  persisted: PersistedUpdate | null,
  beforeSeq: number | null,
  loadUpdateData: (updateSeq: number) => Promise<Buffer>,
): Promise<{ updateSeq: number; updateData: Buffer }> {
  if (persisted) {
    return {
      updateSeq: persisted.updateSeq,
      updateData: Buffer.from(persisted.updateData),
    };
  }
  const updateSeq = beforeSeq ?? 0;
  const updateData = beforeSeq ? await loadUpdateData(beforeSeq) : Buffer.alloc(0);
  return { updateSeq, updateData };
}

async function latestUpdateSeq(
  store: DocumentStore,
  documentId: DocumentId,
): Promise<number | null> {
  const head = await store.getHead(documentId);
  return head?.latestUpdateSeq ?? null;
}

async function latestUpdateData(
  store: DocumentStore,
  documentId: DocumentId,
  updateSeq: number,
): Promise<Buffer> {
  const updates = await store.listUpdatesAfter(documentId, updateSeq - 1);
  const match = updates.find((update) => update.seq === updateSeq);
  return match ? Buffer.from(match.updateData) : Buffer.alloc(0);
}

export function createInMemoryDocumentSyncFacade(
  deps: {
    store?: DocumentStore;
    inner?: InnerDocumentSyncService;
    options?: DocumentSyncServiceOptions;
    resolveDocumentProjection?: (
      documentId: DocumentId,
    ) => Promise<InMemoryDocumentProjection | null> | InMemoryDocumentProjection | null;
  } = {},
): DocumentSyncFacade {
  const store = deps.store ?? createInMemoryDocumentStore();
  const inner = deps.inner ?? createInnerDocumentSyncService(store, deps.options);
  const facadeMutex = new KeyedMutex();
  const projections = new Map<DocumentId, InMemoryDocumentProjection>();

  async function resolveProjection(documentId: DocumentId): Promise<InMemoryDocumentProjection> {
    const cached = projections.get(documentId);
    if (cached) return cached;

    const resolved = await deps.resolveDocumentProjection?.(documentId);
    if (resolved) {
      projections.set(documentId, resolved);
      return resolved;
    }

    return { markdown: "", filetype: "markdown" };
  }

  async function ensureMirror(documentId: DocumentId): Promise<void> {
    const existing = await inner.readAsMarkdown(documentId);
    if (existing.ok) return;

    const projection = await resolveProjection(documentId);
    let result = await inner.getOrCreateMirror(
      documentId,
      projection.markdown,
      projection.filetype,
    );
    if (!result.ok && result.error.code === "corrupt_state") {
      inner.forgetMirror(documentId);
      result = await inner.getOrCreateMirror(documentId, projection.markdown, projection.filetype);
    }
    if (!result.ok) throw syncErrorToHttp(result.error);
  }

  function rememberProjection(documentId: DocumentId, markdown: string, filetype: string): void {
    projections.set(documentId, { markdown, filetype });
  }

  return Object.assign(inner, {
    bindHocuspocus(): void {},

    async loadHocuspocusDocument(): Promise<Uint8Array | undefined> {
      return undefined;
    },

    persistConnectionUpdate(): void {},

    async storeHocuspocusDocument(): Promise<void> {},

    async drainHocuspocusPersistence(): Promise<void> {},

    getPersistenceQueueMetrics() {
      return { queues: [], liveDocumentCount: 0, openConnectionCount: 0 };
    },

    async writeDocument(input: {
      documentId: DocumentId;
      markdown: string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }): Promise<DocumentWriteResult> {
      return facadeMutex.run(input.documentId, async () => {
        await ensureMirror(input.documentId);

        const beforeSeq = await latestUpdateSeq(store, input.documentId);
        const result = await inner.writeFromMarkdown(
          input.documentId,
          input.markdown,
          toUpdateOrigin(input.origin),
        );
        if (!result.ok) throw syncErrorToHttp(result.error);

        const markdownResult = await inner.readAsMarkdown(input.documentId);
        if (!markdownResult.ok) throw syncErrorToHttp(markdownResult.error);
        const { updateSeq, updateData } = await resolveWriteUpdateResult(
          result.value,
          beforeSeq,
          (seq) => latestUpdateData(store, input.documentId, seq),
        );

        const projection = await resolveProjection(input.documentId);
        rememberProjection(input.documentId, markdownResult.value, projection.filetype);

        return {
          documentId: input.documentId,
          markdown: markdownResult.value,
          updateSeq,
          updateData,
          originType: input.origin.type,
          actorTurnId: input.origin.type === "agent" ? input.origin.actorTurnId : null,
          actorUserId: input.origin.type === "user" ? input.origin.actorUserId : null,
        };
      });
    },

    async editDocument(input: {
      documentId: DocumentId;
      transform: (markdown: string) => string;
      origin: DocumentWriteOrigin;
      threadId?: ThreadId;
    }) {
      return facadeMutex.run(input.documentId, async () => {
        await ensureMirror(input.documentId);

        const beforeSeq = await latestUpdateSeq(store, input.documentId);
        const result = await inner.transformFromMarkdown(
          input.documentId,
          input.transform,
          toUpdateOrigin(input.origin),
        );
        if (!result.ok) throw syncErrorToHttp(result.error);

        const { beforeMarkdown, markdown, persistedUpdate } = result.value;
        const { updateSeq, updateData } = await resolveWriteUpdateResult(
          persistedUpdate,
          beforeSeq,
          (seq) => latestUpdateData(store, input.documentId, seq),
        );

        const projection = await resolveProjection(input.documentId);
        rememberProjection(input.documentId, markdown, projection.filetype);

        return {
          documentId: input.documentId,
          beforeMarkdown,
          markdown,
          updateSeq,
          updateData,
          originType: input.origin.type,
          actorTurnId: input.origin.type === "agent" ? input.origin.actorTurnId : null,
          actorUserId: input.origin.type === "user" ? input.origin.actorUserId : null,
        };
      });
    },

    async requireOwnedDocument(_documentId: DocumentId, _userId: UserId): Promise<void> {},

    async getLastUpdateAttribution(documentId: DocumentId) {
      const updates = await store.listUpdatesAfter(documentId, 0);
      const latest = updates.at(-1);
      return {
        originType: latest?.originType ?? null,
        actorTurnId: (latest?.actorTurnId as TurnId | null) ?? null,
        actorUserId: (latest?.actorUserId as UserId | null) ?? null,
        updateSeq: latest?.seq ?? null,
      };
    },
  });
}
