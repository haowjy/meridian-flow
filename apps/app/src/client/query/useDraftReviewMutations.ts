/**
 * useDraftReviewMutations — Apply/Discard actions for Work drafts.
 */

import type {
  DraftApplyChangesRequest,
  DraftApplyChangesResponse,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ThreadDraftListItem,
} from "@meridian/contracts/drafts";
import {
  onlineManager,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { applyDraft, applyDraftChanges, discardDraft } from "@/client/api/drafts-api";
import { httpErrorStatus } from "@/client/api/http-client";
import {
  type ChangeCommandMode,
  type ChangeSelection,
  confirmChangeCommand,
  previewWithoutOperations,
} from "./change-command-record";
import { confirmDraftCommand } from "./draft-command-record";
import { isProjectContextCatalogKey, projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

type DraftReviewMutationBase = {
  projectId: string;
  workId: string;
  threadId?: string | null;
  documentId: string;
  draftId: string;
};

export type DraftApplyMutationInput = DraftReviewMutationBase;

/**
 * A command's request got no HTTP answer, so the server may or may not have
 * acted on it. Distinct from a rejection, which has a status.
 */
export class DraftCommandOutcomeUnknownError extends Error {
  constructor() {
    super("Draft command outcome is unknown");
  }
}

/** Run a request whose lost answer is unknown, not a refusal: only an HTTP answer is a rejection. */
async function sendKnowingOutcome<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (httpErrorStatus(error) !== undefined) throw error;
    throw new DraftCommandOutcomeUnknownError();
  }
}

/**
 * The browser is offline, so the command was not sent. A refusal of the writer's
 * click, not a held request: TanStack would pause these mutations and fire them
 * when the network returned, with the change gone from the screen meanwhile.
 */
export class DraftCommandNotSentError extends Error {
  constructor() {
    super("Draft command was not sent: the browser is offline");
  }
}

function assertOnline(): void {
  if (!onlineManager.isOnline()) throw new DraftCommandNotSentError();
}

/** Disposition commands run now (and refuse when offline) instead of waiting for the network. */
const SEND_NOW = { networkMode: "always" } as const;

export type DraftReviewMutationInput = DraftReviewMutationBase & {
  /** A selective Discard: the changes' operation ids and the revision tokens of the preview the writer saw. */
  request?: Omit<DraftDiscardRequest, "draftId">;
  /**
   * Called with the server's answer the moment it arrives, before the list and
   * preview re-reads that follow. A surface that must act on the answer before
   * those caches move (the review settling because the server closed the draft)
   * cannot wait for the mutation to resolve: that waits for the re-reads.
   */
  onAnswered?: (response: DraftDiscardResponse) => void;
};

function invalidateDraftReviewQueries(
  queryClient: QueryClient,
  {
    projectId,
    workId,
    threadId,
    documentId,
  }: { projectId: string; workId: string; threadId?: string | null; documentId: string },
): Promise<void> {
  if (threadId) {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === projectQueryKeys.all[0] && query.queryKey[2] === "threads",
  });
  // Awaited: these two queries are the disposition state review UIs render
  // from. Returned from onSuccess/onError they hold the mutation isPending
  // until the refetch settles, so verbs re-enable only once the rows they act
  // on are current. Thread invalidations above stay fire-and-forget — they
  // don't gate disposition.
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: projectQueryKeys.workDrafts(projectId, workId),
    }),
    queryClient.invalidateQueries({
      queryKey: ["projects", projectId, "works", workId, "documents", documentId, "draft"],
    }),
  ]).then(() => undefined);
}

/**
 * Apply is done when the server confirms it: the confirmed draft leaves cached
 * pending membership at once, and everything else refreshes in the background.
 * A rejection throws as is. A response that never arrived throws the distinct
 * unknown outcome; nothing here guesses from what the list later shows.
 */
export function useApplyDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    ...SEND_NOW,
    mutationFn: async (variables: DraftApplyMutationInput): Promise<void> => {
      assertOnline();
      const draftsKey = projectQueryKeys.workDrafts(variables.projectId, variables.workId);
      void queryClient.cancelQueries({ queryKey: draftsKey });
      try {
        await sendKnowingOutcome(() =>
          applyDraft(variables.projectId, variables.workId, variables.documentId, {
            draftId: variables.draftId,
          }),
        );
      } catch (error) {
        void invalidateDraftReviewQueries(queryClient, variables).catch(() => undefined);
        throw error;
      }
      confirmDraftCommand(variables);
      queryClient.setQueryData<ThreadDraftListItem[]>(draftsKey, (drafts) =>
        drafts?.filter((draft) => draft.draftId !== variables.draftId),
      );
      void Promise.all([
        queryClient.invalidateQueries({
          predicate: (query) => isProjectContextCatalogKey(query.queryKey, variables.projectId),
        }),
        invalidateDraftReviewQueries(queryClient, variables),
      ]).catch(() => undefined);
    },
  });
}

export function useDiscardDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    ...SEND_NOW,
    mutationFn: async ({
      projectId,
      workId,
      documentId,
      draftId,
      request,
      onAnswered,
    }: DraftReviewMutationInput) => {
      assertOnline();
      const send = () =>
        discardDraft(projectId, workId, documentId, {
          draftId,
          ...(request?.operationIds?.length ? request : {}),
        });
      // A change's Discard that got no answer may have landed, as an Apply's may.
      // A whole-draft Discard is unfenced and reads as not sent.
      const response = await (request?.operationIds?.length ? sendKnowingOutcome(send) : send());
      onAnswered?.(response);
      return response;
    },
    onSuccess: (_response, variables) => invalidateDraftReviewQueries(queryClient, variables),
    onError: (_error, variables) => invalidateDraftReviewQueries(queryClient, variables),
  });
}

export type DraftChangesApplyInput = DraftReviewMutationBase & {
  request: Omit<DraftApplyChangesRequest, "draftId">;
  /** See `DraftReviewMutationInput.onAnswered`. */
  onAnswered?: (response: DraftApplyChangesResponse) => void;
};

/**
 * Apply complete changes (server closure classes) of one draft. The server's
 * answer is data, not an error: a refusal (`stale`, `gone`, ...) resolves, and
 * the caller decides what it means. A rejection with a status throws as is; a
 * request that got no answer throws the distinct unknown outcome, as Apply does. Either way the draft's list and preview
 * are re-read before the mutation settles, so the surfaces that act next read
 * current tokens.
 */
export function useApplyDraftChanges() {
  const queryClient = useQueryClient();

  return useMutation({
    ...SEND_NOW,
    mutationFn: async ({
      projectId,
      workId,
      documentId,
      draftId,
      request,
      onAnswered,
    }: DraftChangesApplyInput) => {
      assertOnline();
      const response = await sendKnowingOutcome(() =>
        applyDraftChanges(projectId, workId, documentId, { draftId, ...request }),
      );
      onAnswered?.(response);
      return response;
    },
    onSuccess: (_response, variables) => invalidateDraftReviewQueries(queryClient, variables),
    onError: (_error, variables) => invalidateDraftReviewQueries(queryClient, variables),
  });
}

/**
 * The server confirmed a selection (applied, or discarded): its changes leave
 * the cached preview now, and preview reads already in flight can no longer
 * bring them back.
 */
export function settleConfirmedChange(
  queryClient: QueryClient,
  draft: DraftReviewMutationBase,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
): void {
  const hidden = new Set(selection.operationIds);
  queryClient.setQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.draftId,
    ),
    (preview) => (preview ? previewWithoutOperations(preview, hidden) : preview),
  );
  confirmChangeCommand(draft, selection, mode);
}
