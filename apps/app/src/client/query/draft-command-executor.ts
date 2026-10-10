/** Admission and settlement of typed draft commands; records own their cross-surface lifetime. */
import type {
  DraftApplyChangesResponse,
  DraftApplyResponse,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ThreadDraftListItem,
} from "@meridian/contracts/drafts";
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { applyDraft, applyDraftChanges, discardDraft } from "@/client/api/drafts-api";
import { httpErrorStatus } from "@/client/api/http-client";
import { coversEveryChange } from "@/features/draft-review/change-selection";
import type { DraftReviewSelection } from "@/features/draft-review/draft-review-session";
import { reviewChangesOfPreview } from "@/features/draft-review/review-changes";
import {
  answerDraftCommandClosed,
  answerDraftSelection,
  beginChangeCommand,
  beginDraftBatch,
  beginDraftCommand,
  type ChangeFailureCode,
  type ChangeSelection,
  confirmChangeCommand,
  confirmDraftCommand,
  currentDraftCommandRecords,
  type DraftCommandFailure,
  type DraftRef,
  failChangeCommand,
  failDraftCommand,
  type PendingDraftCommand,
  pendingDraftCommand,
  previewWithoutOperations,
  queueChangeSelection,
  releaseDraftCommand,
} from "./draft-command-record";
import { classifyDraftCommandRejection } from "./draft-command-rejection";
import { isProjectContextCatalogKey, projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

export type DraftCommandOutcome =
  | { kind: "blocked" }
  | { kind: "applied" }
  | { kind: "apply-outcome-unknown" }
  | { kind: "discarded" }
  | { kind: "change-settled"; mode: Mode }
  | { kind: "change-refused"; mode: Mode; code: ChangeFailureCode }
  | { kind: "failed"; failure: DraftCommandFailure };
type Mode = "apply" | "discard";
export type ChangeBasis = {
  liveRevisionToken: string;
  draftRevisionToken: string;
  draftGeneration: number;
};
export type DraftCommand =
  | {
      target: "all";
      draft: DraftRef;
      mode: Mode;
      generation: number | undefined;
      completesDraft?: boolean;
    }
  | {
      target: "selection";
      draft: DraftRef;
      mode: Mode;
      selection: ChangeSelection;
      basis: ChangeBasis;
      completesDraft: boolean;
    };
export type CommandStart = { sent: boolean; outcome: Promise<DraftCommandOutcome> };
export type SelectionCommand = (
  draft: DraftReviewSelection,
  selection: ChangeSelection,
) => Promise<DraftCommandOutcome>;
export type DraftSelection = { draft: DraftReviewSelection; selection: ChangeSelection };
type Scope = { projectId: string; workId: string };

export function listedDocumentName(
  queryClient: QueryClient,
  projectId: string,
  workId: string,
  draftId: string,
): string | null {
  return (
    queryClient
      .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(projectId, workId))
      ?.find((item) => item.draftId === draftId)?.documentName ?? null
  );
}

export function newestKnownProposal(queryClient: QueryClient, draft: DraftRef): number | undefined {
  const cached = queryClient.getQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.draftId,
    ),
  );
  const row = queryClient
    .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(draft.projectId, draft.workId))
    ?.find((item) => item.draftId === draft.draftId);
  const known = [
    cached?.status === "active" && reviewChangesOfPreview(cached).length > 0
      ? cached.draftGeneration
      : undefined,
    row?.draftGeneration,
  ].filter((generation) => generation !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

function refresh(
  queryClient: QueryClient,
  draft: DraftRef,
  threadId: string | null,
): Promise<void> {
  if (threadId) {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === projectQueryKeys.all[0] && query.queryKey[2] === "threads",
  });
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: projectQueryKeys.workDrafts(draft.projectId, draft.workId),
    }),
    queryClient.invalidateQueries({
      queryKey: [
        "projects",
        draft.projectId,
        "works",
        draft.workId,
        "documents",
        draft.documentId,
        "draft",
      ],
    }),
  ]).then(() => undefined);
}

function canSendDraftCommand(): boolean {
  return navigator.onLine && onlineManager.isOnline();
}

/** Claim and connectivity are decided together, before the caller takes optimistic UI effects. */
export function startDraftCommand(
  queryClient: QueryClient,
  command: DraftCommand,
  threadId: string | null = null,
  reserved = false,
  onSent?: () => void,
): CommandStart {
  const { draft, mode } = command;
  if (!reserved && pendingDraftCommand(currentDraftCommandRecords(), draft))
    return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
  if (!canSendDraftCommand()) {
    const outcome: DraftCommandOutcome =
      command.target === "all"
        ? { kind: "failed", failure: { code: `${mode}-offline` } }
        : { kind: "change-refused", mode, code: "offline" };
    if (command.target === "all" && outcome.kind === "failed")
      failDraftCommand(draft, outcome.failure);
    else if (command.target === "selection")
      failChangeCommand(draft, command.selection, mode, "offline");
    releaseDraftCommand(draft);
    return { sent: false, outcome: Promise.resolve(outcome) };
  }
  const claimed =
    reserved ||
    (command.target === "all"
      ? beginDraftCommand(draft, {
          target: "all",
          mode,
          draftGeneration: command.generation,
          ...(command.completesDraft ? { completesDraft: true } : {}),
        })
      : beginChangeCommand(
          draft,
          command.selection,
          mode,
          command.basis.draftGeneration,
          command.completesDraft,
        ));
  if (!claimed) return { sent: false, outcome: Promise.resolve({ kind: "blocked" }) };
  try {
    onSent?.();
  } catch (error) {
    releaseDraftCommand(draft);
    return { sent: false, outcome: Promise.reject(error) };
  }
  return { sent: true, outcome: execute(queryClient, command, threadId) };
}

async function execute(
  queryClient: QueryClient,
  command: DraftCommand,
  threadId: string | null,
): Promise<DraftCommandOutcome> {
  const { draft, mode } = command;
  const refreshDraft = () => refresh(queryClient, draft, threadId);
  try {
    if (command.target === "all" && mode === "apply")
      void queryClient.cancelQueries({
        queryKey: projectQueryKeys.workDrafts(draft.projectId, draft.workId),
      });
    // TanStack is the request adapter, never an offline queue.
    const response = await queryClient
      .getMutationCache()
      .build<
        DraftApplyResponse | DraftApplyChangesResponse | DraftDiscardResponse,
        unknown,
        void,
        unknown
      >(queryClient, {
        networkMode: "always",
        mutationFn: () => {
          if (command.target === "all") {
            const request = { draftId: draft.draftId };
            return mode === "apply"
              ? applyDraft(draft.projectId, draft.workId, draft.documentId, request)
              : discardDraft(draft.projectId, draft.workId, draft.documentId, request);
          }
          const request = {
            draftId: draft.draftId,
            operationIds: [...command.selection.operationIds],
            liveRevisionToken: command.basis.liveRevisionToken,
            draftRevisionToken: command.basis.draftRevisionToken,
          };
          return mode === "apply"
            ? applyDraftChanges(draft.projectId, draft.workId, draft.documentId, request)
            : discardDraft(draft.projectId, draft.workId, draft.documentId, request);
        },
      })
      .execute(undefined);
    if (response.status === "applied" || response.status === "discarded") {
      if (command.target === "all" || ("draftClosed" in response && response.draftClosed))
        answerDraftCommandClosed(draft, {
          documentName: listedDocumentName(
            queryClient,
            draft.projectId,
            draft.workId,
            draft.draftId,
          ),
        });
    }
    if (command.target === "all") {
      if (mode === "apply") {
        confirmDraftCommand(draft);
        queryClient.setQueryData<ThreadDraftListItem[]>(
          projectQueryKeys.workDrafts(draft.projectId, draft.workId),
          (drafts) =>
            drafts?.filter(
              (item) =>
                item.draftId !== draft.draftId ||
                command.generation === undefined ||
                item.draftGeneration > command.generation,
            ),
        );
        void Promise.all([
          queryClient.invalidateQueries({
            predicate: (query) => isProjectContextCatalogKey(query.queryKey, draft.projectId),
          }),
          refreshDraft(),
        ]).catch(() => undefined);
      } else await refreshDraft();
      return { kind: mode === "apply" ? "applied" : "discarded" };
    }
    const confirmed = response.status === (mode === "apply" ? "applied" : "discarded");
    if (confirmed || response.status === "gone") {
      answerDraftSelection(
        draft,
        response.status === "gone" ? "change-gone" : mode === "apply" ? "applied" : "discarded",
      );
      // Keep the claim while reads settle; then prune their result and fence older reads.
      await refreshDraft();
      const hidden = new Set(command.selection.operationIds);
      queryClient.setQueryData<DraftPreviewResponse>(
        projectQueryKeys.workDraftPreview(
          draft.projectId,
          draft.workId,
          draft.documentId,
          draft.draftId,
        ),
        (preview) => (preview ? previewWithoutOperations(preview, hidden) : preview),
      );
      confirmChangeCommand(draft, command.selection, mode);
      return confirmed
        ? { kind: "change-settled", mode }
        : { kind: "change-refused", mode, code: "gone" };
    }
    await refreshDraft();
    const code = response.status === "draft_only" ? "draft-only" : "stale";
    failChangeCommand(draft, command.selection, mode, code);
    return { kind: "change-refused", mode, code };
  } catch (error) {
    if (command.target === "all" && mode === "apply") void refreshDraft().catch(() => undefined);
    else await refreshDraft().catch(() => undefined);
    const unknown =
      httpErrorStatus(error) === undefined && (command.target === "selection" || mode === "apply");
    const rejection = classifyDraftCommandRejection(error);
    if (command.target === "selection") {
      const code = unknown ? "unknown" : rejection.kind;
      failChangeCommand(
        draft,
        command.selection,
        mode,
        code,
        rejection.kind === "refused"
          ? { serverCode: rejection.serverCode, serverReason: rejection.serverReason }
          : undefined,
      );
      return { kind: "change-refused", mode, code };
    }
    const failure: DraftCommandFailure = unknown
      ? { code: "apply-unknown" }
      : {
          code: `${mode}-${rejection.kind}`,
          ...(rejection.kind === "refused"
            ? {
                serverCode: rejection.serverCode,
                ...(rejection.serverReason ? { serverReason: rejection.serverReason } : {}),
              }
            : {}),
        };
    failDraftCommand(draft, failure);
    return unknown ? { kind: "apply-outcome-unknown" } : { kind: "failed", failure };
  } finally {
    releaseDraftCommand(draft);
  }
}

/** Selection preparation belongs to execution, not to the review controller. */
export function runDraftSelection(
  queryClient: QueryClient,
  scope: Scope,
  mode: Mode,
  draft: DraftReviewSelection,
  selection: ChangeSelection,
  threadId: string | null,
): Promise<DraftCommandOutcome> {
  if (!selection.operationIds.length) return Promise.resolve({ kind: "blocked" });
  const target = { ...scope, ...draft };
  const cached = queryClient.getQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      scope.projectId,
      scope.workId,
      draft.documentId,
      draft.draftId,
    ),
  );
  if (cached?.status !== "active")
    return Promise.resolve({ kind: "change-refused", mode, code: "stale" });
  return startDraftCommand(
    queryClient,
    {
      target: "selection",
      draft: target,
      mode,
      selection,
      basis: {
        liveRevisionToken: cached.liveRevisionToken,
        draftRevisionToken: cached.draftRevisionToken,
        draftGeneration: cached.draftGeneration,
      },
      completesDraft: coversEveryChange(selection, reviewChangesOfPreview(cached)),
    },
    threadId,
  ).outcome;
}

export type DraftBatchItem = { draft: DraftReviewSelection } & (
  | { selection: ChangeSelection; command?: never }
  | { command: PendingDraftCommand; selection?: never }
);
export type DraftBatchOutcome = { draft: DraftReviewSelection; outcome: DraftCommandOutcome };

/** Both whole and selective batches pin their starting Work and expose one busy lifetime. */
export async function runDraftBatch<T extends DraftBatchItem>(
  scope: Scope,
  items: readonly T[],
  send: (item: T) => Promise<DraftCommandOutcome>,
): Promise<DraftBatchOutcome[]> {
  if (!items.length) return [];
  const release = beginDraftBatch(scope);
  if (!release) return items.map(({ draft }) => ({ draft, outcome: { kind: "blocked" } }));
  const retires: (() => void)[] = [];
  const outcomes: DraftBatchOutcome[] = [];
  const blocked = new Set<number>();
  try {
    // An offline batch refuses every click in this admission turn. Reconnect
    // cannot admit a later file from a batch that was never sent.
    if (!canSendDraftCommand())
      return await Promise.all(
        items.map(async (item) => ({ draft: item.draft, outcome: await send(item) })),
      );
    for (const [index, { draft, selection, command }] of items.entries()) {
      if (command) {
        if (beginDraftCommand({ ...scope, ...draft }, command))
          retires.push(() => {
            const target = { ...scope, ...draft };
            if (pendingDraftCommand(currentDraftCommandRecords(), target) === command)
              releaseDraftCommand(target);
          });
        else {
          blocked.add(index);
          retires.push(() => {});
        }
      } else
        retires.push(
          selection ? queueChangeSelection({ ...scope, ...draft }, selection) : () => {},
        );
    }
    for (const [index, item] of items.entries()) {
      const outcome = blocked.has(index)
        ? Promise.resolve<DraftCommandOutcome>({ kind: "blocked" })
        : send(item);
      if (item.selection) retires[index]?.();
      outcomes.push({ draft: item.draft, outcome: await outcome });
    }
    return outcomes;
  } finally {
    for (const retire of retires) retire();
    release();
  }
}
