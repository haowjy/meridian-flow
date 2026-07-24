/** Policy for projection/activity effects after durable document writes. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { DocumentWriteHook } from "../contracts.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import { syncErrorMessage } from "./markdown-document.js";
import type { DocumentProjectionEffects } from "./ports/document-projection-effects.js";

export type DocumentProjectionRefreshService = {
  refresh(input: { documentId: DocumentId; threadId?: ThreadId }, source?: string): Promise<void>;
};

export type DocumentWriteHookRunner = (
  event: Omit<Parameters<DocumentWriteHook>[0], "at">,
  source?: string,
) => Promise<void>;

export function createProjectionEffectsDocumentWriteHook(
  effects: DocumentProjectionEffects,
): DocumentWriteHook {
  return ({ documentId, threadId, markdown, at }) =>
    effects.apply({
      documentId,
      markdown,
      at,
      threadDocuments: threadId ? { kind: "thread", threadId } : { kind: "none" },
      work: { kind: "document_scope" },
      project: {
        kind: "document_scope",
        includeWorkProject: true,
        activeDocumentsOnly: false,
      },
    });
}

export function createDocumentWriteHookRunner(input: {
  hook: DocumentWriteHook;
  eventSink?: EventSink;
}): DocumentWriteHookRunner {
  return async (event, source = "collab.document_write") => {
    const hookEvent = { ...event, at: new Date() };
    try {
      await input.hook(hookEvent);
    } catch (cause) {
      emitFailure(input.eventSink, {
        documentId: hookEvent.documentId,
        threadId: hookEvent.threadId,
        source,
        name: "post_write_hook.failed",
        payload: unknownToEventPayload(cause),
      });
    }
  };
}

export function createDocumentProjectionRefresher(input: {
  documents: Pick<MarkdownDocumentEngine, "readAsMarkdown">;
  runDocumentWriteHook: DocumentWriteHookRunner;
  eventSink?: EventSink;
}): DocumentProjectionRefreshService {
  return {
    async refresh({ documentId, threadId }, source = "collab.document_write") {
      try {
        const read = await input.documents.readAsMarkdown(documentId);
        if (!read.ok) {
          emitFailure(input.eventSink, {
            documentId,
            threadId,
            source,
            name: "projection_refresh.failed",
            payload: {
              code: read.error.code,
              message: syncErrorMessage(read.error),
            },
          });
          return;
        }
        await input.runDocumentWriteHook({ documentId, threadId, markdown: read.value }, source);
      } catch (cause) {
        emitFailure(input.eventSink, {
          documentId,
          threadId,
          source,
          name: "projection_refresh.failed",
          payload: unknownToEventPayload(cause),
        });
      }
    },
  };
}

function emitFailure(
  eventSink: EventSink | undefined,
  input: {
    documentId: DocumentId;
    threadId?: ThreadId;
    source: string;
    name: string;
    payload: Record<string, unknown>;
  },
): void {
  if (!eventSink) return;
  emitEvent(eventSink, {
    level: "error",
    source: input.source,
    name: input.name,
    payload: {
      documentId: input.documentId,
      threadId: input.threadId ?? null,
      ...input.payload,
    },
  });
}
