/** useInlineReviewRejectOperation — controller command for undoable per-operation draft discard. */
import type { ReviewOperation } from "@meridian/contracts/drafts";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { useCallback, useRef } from "react";
import * as Y from "yjs";

import { getDraftJournal, getDraftPreview, StaleDraftJournalError } from "@/client/api/drafts-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  buildInlineReviewModel,
  getInlineReviewPluginState,
  type InlineReviewModel,
} from "@/core/editor/extensions/inline-review";
import {
  applyRejectUpdate,
  decodeDraftJournalResponse,
  reconstructOperationRejectUpdate,
  stateVectorsEqual,
} from "@/core/editor/inline-review-runtime";

const MAX_FRESHNESS_RETRIES = 2;
const SETTLE_BEFORE_RETRY_MS = 550;

export type InlineReviewRejectOutcome =
  | { status: "applied" }
  | { status: "stale" }
  | { status: "finalized" }
  | { status: "offline" };

export type InlineReviewRejectContext = {
  editor: Editor | null;
  draftDoc: Y.Doc;
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
};

export function useInlineReviewRejectOperation({
  editor,
  draftDoc,
  projectId,
  workId,
  documentId,
  draftId,
}: InlineReviewRejectContext) {
  const queryClient = useQueryClient();
  const journalCacheRef = useRef<Map<number, ReturnType<typeof decodeDraftJournalResponse>>>(
    new Map(),
  );

  return useCallback(
    async (operationId: string): Promise<InlineReviewRejectOutcome> => {
      return rejectOperation({
        editor,
        draftDoc,
        projectId,
        workId,
        documentId,
        draftId,
        operationId,
        queryClient,
        journalCache: journalCacheRef.current,
      });
    },
    [draftDoc, draftId, documentId, editor, queryClient, projectId, workId],
  );
}

async function rejectOperation(input: {
  editor: Editor | null;
  draftDoc: Y.Doc;
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
  operationId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  journalCache: Map<number, ReturnType<typeof decodeDraftJournalResponse>>;
}): Promise<InlineReviewRejectOutcome> {
  const {
    editor,
    draftDoc,
    projectId,
    workId,
    documentId,
    draftId,
    operationId,
    queryClient,
    journalCache,
  } = input;
  if (!editor || editor.isDestroyed) throw new Error("The draft editor is not ready.");

  let model = currentInlineReviewModel(editor);
  let revisionToken = model?.draftRevisionToken;
  if (!model || revisionToken === undefined) {
    throw new Error("The draft review model is not ready.");
  }

  for (let attempt = 0; attempt <= MAX_FRESHNESS_RETRIES; attempt += 1) {
    const operation = operationById(model, operationId);
    if (!operation) return { status: "finalized" };

    try {
      const snapshot = await journalSnapshotForRevision({
        cache: journalCache,
        projectId,
        workId,
        documentId,
        draftId,
        revisionToken,
      });
      const { inverseUpdate, journalEndStateVector } = reconstructOperationRejectUpdate({
        snapshot,
        operation,
        documentId,
      });

      if (!stateVectorsEqual(Y.encodeStateVector(draftDoc), journalEndStateVector)) {
        if (attempt >= MAX_FRESHNESS_RETRIES) return { status: "stale" };
        await waitForSettledEditor();
        const refreshed = await refreshInlineModel({
          projectId,
          workId,
          documentId,
          draftId,
          editor,
        });
        model = refreshed.model;
        revisionToken = refreshed.revisionToken;
        continue;
      }

      applyRejectUpdate({
        doc: draftDoc,
        editor,
        editorState: editor.state,
        inverseUpdate,
      });
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(
          projectId,
          workId,
          documentId,
          draftId,
          "inline",
        ),
      });
      return { status: "applied" };
    } catch (error) {
      if (error instanceof StaleDraftJournalError) {
        if (attempt >= MAX_FRESHNESS_RETRIES) return { status: "stale" };
        await waitForSettledEditor();
        const refreshed = await refreshInlineModel({
          projectId,
          workId,
          documentId,
          draftId,
          editor,
        });
        model = refreshed.model;
        revisionToken = refreshed.revisionToken;
        continue;
      }
      if (error instanceof TypeError) return { status: "offline" };
      throw error;
    }
  }

  return { status: "stale" };
}

function currentInlineReviewModel(editor: Editor): InlineReviewModel | null {
  return getInlineReviewPluginState(editor.state)?.model ?? null;
}

function operationById(model: InlineReviewModel, operationId: string): ReviewOperation | null {
  return model.operations.find((operation) => operation.operationId === operationId) ?? null;
}

async function refreshInlineModel(input: {
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
  editor: Editor;
}): Promise<{ model: InlineReviewModel; revisionToken: number }> {
  const refreshed = await getDraftPreview(
    input.projectId,
    input.workId,
    input.documentId,
    input.draftId,
    {
      surface: "inline",
    },
  );
  if (refreshed.status !== "active" || !refreshed.inlineModelPresent) {
    return Promise.reject(new Error("The draft is no longer available."));
  }
  const model = buildInlineReviewModel({
    liveRevisionToken: refreshed.liveRevisionToken,
    draftRevisionToken: refreshed.draftRevisionToken,
    operations: refreshed.operations,
    hunks: refreshed.hunks,
  });
  input.editor.commands.setInlineReviewModel(model);
  return { model, revisionToken: refreshed.draftRevisionToken };
}

async function journalSnapshotForRevision(input: {
  cache: Map<number, ReturnType<typeof decodeDraftJournalResponse>>;
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
  revisionToken: number;
}): Promise<ReturnType<typeof decodeDraftJournalResponse>> {
  const cached = input.cache.get(input.revisionToken);
  if (cached) return cached;
  const response = await getDraftJournal(
    input.projectId,
    input.workId,
    input.documentId,
    input.draftId,
    input.revisionToken,
  );
  const decoded = decodeDraftJournalResponse(response);
  input.cache.set(input.revisionToken, decoded);
  return decoded;
}

function waitForSettledEditor(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, SETTLE_BEFORE_RETRY_MS));
}
