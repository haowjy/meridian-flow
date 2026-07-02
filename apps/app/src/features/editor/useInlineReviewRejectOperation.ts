/** useInlineReviewRejectOperation — controller command for undoable per-operation draft discard. */
import type { ReviewOperation } from "@meridian/contracts/drafts";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { useCallback, useRef } from "react";
import type * as Y from "yjs";

import { getDraftJournal, getDraftPreview, StaleDraftJournalError } from "@/client/api/drafts-api";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import {
  applyRejectUpdate,
  buildInlineReviewModel,
  decodeDraftJournalResponse,
  getInlineReviewPluginState,
  type InlineReviewModel,
  reconstructOperationRejectUpdate,
} from "@/core/editor/extensions/inline-review";

const MAX_STALE_RETRIES = 1;

export type InlineReviewRejectContext = {
  editor: Editor | null;
  draftDoc: Y.Doc;
  threadId: string;
  documentId: string;
  draftId: string;
};

export function useInlineReviewRejectOperation({
  editor,
  draftDoc,
  threadId,
  documentId,
  draftId,
}: InlineReviewRejectContext) {
  const queryClient = useQueryClient();
  const journalCacheRef = useRef<Map<number, ReturnType<typeof decodeDraftJournalResponse>>>(
    new Map(),
  );

  return useCallback(
    async (operationId: string) => {
      if (!editor || editor.isDestroyed) throw new Error("The draft editor is not ready.");

      let model = currentInlineReviewModel(editor);
      let revisionToken = model?.draftRevisionToken;
      if (!model || revisionToken === undefined) {
        throw new Error("The draft review model is not ready.");
      }

      for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt += 1) {
        const operation = operationById(model, operationId);
        if (!operation) throw new Error("That proposal is no longer available.");
        try {
          const snapshot = await journalSnapshotForRevision({
            cache: journalCacheRef.current,
            threadId,
            documentId,
            draftId,
            revisionToken,
          });
          const inverseUpdate = reconstructOperationRejectUpdate({
            snapshot,
            operation,
            documentId,
          });
          applyRejectUpdate({ doc: draftDoc, editorState: editor.state, inverseUpdate });
          void queryClient.invalidateQueries({
            queryKey: threadQueryKeys.draftPreview(threadId, documentId, draftId, "inline"),
          });
          return;
        } catch (error) {
          if (!(error instanceof StaleDraftJournalError) || attempt >= MAX_STALE_RETRIES) {
            throw error;
          }
          const refreshed = await getDraftPreview(threadId, documentId, draftId, {
            surface: "inline",
          });
          if (
            refreshed.status !== "active" ||
            !Array.isArray(refreshed.operations) ||
            !Array.isArray(refreshed.hunks)
          ) {
            throw new Error("Couldn't discard — the draft changed. Try again.");
          }
          revisionToken = refreshed.draftRevisionToken;
          model = buildInlineReviewModel({
            liveRevisionToken: refreshed.liveRevisionToken,
            draftRevisionToken: refreshed.draftRevisionToken,
            operations: refreshed.operations,
            hunks: refreshed.hunks,
          });
          editor.commands.setInlineReviewModel(model);
        }
      }
    },
    [draftDoc, draftId, documentId, editor, queryClient, threadId],
  );
}

function currentInlineReviewModel(editor: Editor): InlineReviewModel | null {
  return getInlineReviewPluginState(editor.state)?.model ?? null;
}

function operationById(model: InlineReviewModel, operationId: string): ReviewOperation | null {
  return model.operations.find((operation) => operation.operationId === operationId) ?? null;
}

async function journalSnapshotForRevision(input: {
  cache: Map<number, ReturnType<typeof decodeDraftJournalResponse>>;
  threadId: string;
  documentId: string;
  draftId: string;
  revisionToken: number;
}): Promise<ReturnType<typeof decodeDraftJournalResponse>> {
  const cached = input.cache.get(input.revisionToken);
  if (cached) return cached;
  const response = await getDraftJournal(
    input.threadId,
    input.documentId,
    input.draftId,
    input.revisionToken,
  );
  const decoded = decodeDraftJournalResponse(response);
  input.cache.set(input.revisionToken, decoded);
  return decoded;
}
