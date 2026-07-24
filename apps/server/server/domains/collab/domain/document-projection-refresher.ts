/** Policy for projection/activity effects after durable document writes. */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DocumentWriteHook } from "../contracts.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import { syncErrorMessage } from "./markdown-document.js";
import type { DocumentProjectionEffects } from "./ports/document-projection-effects.js";

export type DocumentProjectionRefreshService = {
  refresh(input: { documentId: DocumentId; threadId?: ThreadId }, source?: string): Promise<void>;
};

export type DocumentProjectionDiagnostics = {
  failed(input: {
    documentId: DocumentId;
    threadId?: ThreadId;
    source: string;
    name: "post_write_hook.failed" | "projection_refresh.failed";
    payload: Record<string, unknown>;
  }): void;
  payload(cause: unknown): Record<string, unknown>;
};

export type DocumentWriteHookRunner = (
  event: Omit<Parameters<DocumentWriteHook>[0], "at">,
  source?: string,
) => Promise<void>;

export function createProjectionEffectsDocumentWriteHook(
  effects: DocumentProjectionEffects,
): DocumentWriteHook {
  return async ({ documentId, threadId, markdown, at }) => {
    const results = await Promise.allSettled([
      effects.touchDocumentActivity({ documentId, threadId, at }),
      effects.updateProjection({ documentId, markdown, at }),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
}

export function createDocumentWriteHookRunner(input: {
  hook: DocumentWriteHook;
  diagnostics: DocumentProjectionDiagnostics;
}): DocumentWriteHookRunner {
  return async (event, source = "collab.document_write") => {
    const hookEvent = { ...event, at: new Date() };
    try {
      await input.hook(hookEvent);
    } catch (cause) {
      input.diagnostics.failed({
        documentId: hookEvent.documentId,
        threadId: hookEvent.threadId,
        source,
        name: "post_write_hook.failed",
        payload: input.diagnostics.payload(cause),
      });
    }
  };
}

export function createDocumentProjectionRefresher(input: {
  documents: Pick<MarkdownDocumentEngine, "readAsMarkdown">;
  runDocumentWriteHook: DocumentWriteHookRunner;
  diagnostics: DocumentProjectionDiagnostics;
}): DocumentProjectionRefreshService {
  return {
    async refresh({ documentId, threadId }, source = "collab.document_write") {
      try {
        const read = await input.documents.readAsMarkdown(documentId);
        if (!read.ok) {
          input.diagnostics.failed({
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
        input.diagnostics.failed({
          documentId,
          threadId,
          source,
          name: "projection_refresh.failed",
          payload: input.diagnostics.payload(cause),
        });
      }
    },
  };
}
