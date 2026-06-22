/**
 * Server-side full-document markdown SET/read engine for collab documents.
 *
 * This intentionally stays out of `@meridian/agent-edit`: full-document SET is a
 * Meridian server persistence/read-model concern, built only by orchestrating the
 * package codec/model, Yjs fragment helper, journal, and document coordinator.
 */
import type { TransactionOrigin } from "@hocuspocus/server";
import {
  type Codec,
  type DocumentCoordinator,
  type DocumentLifecycle,
  fragmentOf,
  isDocumentNotFoundError,
  type ParsedContent,
  type UpdateJournal,
  type UpdateMeta,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  DocumentWriteOrigin,
  DocumentWriteResult,
  PersistedUpdate,
  SyncError,
  UpdateOrigin,
} from "../index.js";

export type RuntimeOrigin = UpdateOrigin | DocumentWriteOrigin;

export type MarkdownSetResult = {
  documentId: DocumentId;
  markdown: string;
  updateSeq: number;
  updateData: Uint8Array;
  meta: UpdateMeta;
};

export type MarkdownEditResult = MarkdownSetResult & { beforeMarkdown: string };

type MarkdownWriteHook = (event: {
  documentId: DocumentId;
  threadId?: ThreadId;
  markdown: string;
}) => Promise<void>;

type MarkdownDocumentEngineDeps = {
  codec: Codec;
  model: YProsemirrorDocumentModel;
  journal: UpdateJournal;
  coordinator: DocumentCoordinator;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  metaForOrigin(origin: RuntimeOrigin): UpdateMeta;
  afterWrite?: MarkdownWriteHook;
};

export type MarkdownDocumentEngine = {
  serializeDoc(doc: Y.Doc): string;
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  setMarkdown(input: {
    documentId: DocumentId;
    markdown: string;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>>;
  editMarkdown(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownEditResult, SyncError>>;
  writeFromMarkdown(
    documentId: string,
    markdown: string,
    origin: UpdateOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  writeDocument(input: {
    documentId: DocumentId;
    markdown: string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult>;
  editDocument(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult & { beforeMarkdown: string }>;
};

export function createMarkdownDocumentEngine(
  deps: MarkdownDocumentEngineDeps,
): MarkdownDocumentEngine {
  function serializeDoc(doc: Y.Doc): string {
    const blocks = deps.model.getBlocks(doc);
    if (blocks.length === 0) return "";
    return deps.codec.serialize(blocks.map((block) => deps.model.toProsemirrorBlock(doc, block)));
  }

  function parseMarkdown(
    documentId: DocumentId,
    markdown: string,
  ): Result<ParsedContent, SyncError> {
    try {
      return Ok(deps.codec.parse(markdown));
    } catch (cause) {
      return Err({
        code: "corrupt_state",
        documentId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function replaceLiveDocumentMarkdown(
    documentId: DocumentId,
    liveDoc: Y.Doc,
    parsed: ParsedContent,
    origin: RuntimeOrigin,
  ): Promise<Result<MarkdownSetResult, SyncError>> {
    const draft = new Y.Doc({ gc: false });
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(liveDoc));
    const beforeVector = Y.encodeStateVector(draft);
    const yjsOrigin = yjsTransactionOrigin(origin);
    draft.transact(() => {
      const fragment = fragmentOf(draft);
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      deps.model.insertBlocks(draft, null, parsed);
    }, yjsOrigin);
    const update = Y.encodeStateAsUpdate(draft, beforeVector);
    const meta = deps.metaForOrigin(origin);
    const seq = await deps.journal.append(documentId, update, meta);
    Y.applyUpdate(liveDoc, update, yjsOrigin);
    return Ok({
      documentId,
      markdown: serializeDoc(draft),
      updateSeq: seq,
      updateData: update,
      meta: { ...meta, seq },
    });
  }

  async function setMarkdown(input: {
    documentId: DocumentId;
    markdown: string;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>> {
    const parsed = parseMarkdown(input.documentId, input.markdown);
    if (!parsed.ok) return parsed;

    await deps.lifecycle.ensureDocument(input.documentId);

    try {
      const result = await deps.coordinator.withDocument(input.documentId, (liveDoc) =>
        replaceLiveDocumentMarkdown(input.documentId, liveDoc, parsed.value, input.origin),
      );
      if (result.ok) {
        await deps.afterWrite?.({
          documentId: result.value.documentId,
          threadId: input.threadId,
          markdown: result.value.markdown,
        });
      }
      return result;
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) {
        return Err({ code: "not_found", documentId: input.documentId });
      }
      throw cause;
    }
  }

  async function editMarkdown(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownEditResult, SyncError>> {
    await deps.lifecycle.ensureDocument(input.documentId);

    try {
      const result = await deps.coordinator.withDocument(input.documentId, async (liveDoc) => {
        const beforeMarkdown = serializeDoc(liveDoc);
        const parsed = parseMarkdown(input.documentId, input.transform(beforeMarkdown));
        if (!parsed.ok) return parsed;

        const result = await replaceLiveDocumentMarkdown(
          input.documentId,
          liveDoc,
          parsed.value,
          input.origin,
        );
        return result.ok ? Ok({ ...result.value, beforeMarkdown }) : result;
      });
      if (result.ok) {
        await deps.afterWrite?.({
          documentId: result.value.documentId,
          threadId: input.threadId,
          markdown: result.value.markdown,
        });
      }
      return result;
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) {
        return Err({ code: "not_found", documentId: input.documentId });
      }
      throw cause;
    }
  }

  return {
    serializeDoc,

    async readAsMarkdown(documentId) {
      try {
        const markdown = await deps.coordinator.withDocument(documentId, async (doc) =>
          serializeDoc(doc),
        );
        return Ok(markdown);
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) return Err({ code: "not_found", documentId });
        throw cause;
      }
    },

    setMarkdown,

    editMarkdown,

    async writeFromMarkdown(documentId, markdown, origin) {
      const result = await setMarkdown({ documentId: documentId as DocumentId, markdown, origin });
      return result.ok ? Ok(persistedUpdate(result.value)) : result;
    },

    async writeDocument(input) {
      const result = await setMarkdown(input);
      if (!result.ok) throwSyncError(result.error);
      return documentWriteResult(result.value, input.origin);
    },

    async editDocument(input) {
      const result = await editMarkdown(input);
      if (!result.ok) throwSyncError(result.error);
      return {
        ...documentWriteResult(result.value, input.origin),
        beforeMarkdown: result.value.beforeMarkdown,
      };
    },
  };
}

export function syncErrorMessage(error: SyncError): string {
  switch (error.code) {
    case "not_found":
      return `Document not found: ${error.documentId}`;
    case "checkpoint_not_found":
      return `Checkpoint not found: ${error.checkpointId}`;
    case "corrupt_state":
      return error.message;
  }
}

function throwSyncError(error: SyncError): never {
  throw new Error(syncErrorMessage(error));
}

function persistedUpdate(result: MarkdownSetResult): PersistedUpdate {
  return { updateSeq: result.updateSeq, updateData: result.updateData };
}

function documentWriteResult(
  result: MarkdownSetResult,
  origin: DocumentWriteOrigin,
): DocumentWriteResult {
  return {
    documentId: result.documentId,
    markdown: result.markdown,
    updateSeq: result.updateSeq,
    updateData: Buffer.from(result.updateData),
    originType: origin.type,
    actorTurnId: origin.type === "agent" ? origin.actorTurnId : null,
    actorUserId: origin.type === "user" ? origin.actorUserId : null,
  };
}

function yjsTransactionOrigin(origin: RuntimeOrigin): TransactionOrigin {
  return { source: "local", context: { origin } };
}
