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
import { coversEveryChange, selectionOf } from "@/features/draft-review/change-selection";
import type { DraftReviewSelection } from "@/features/draft-review/draft-review-session";
import { reviewChangesOfPreview } from "@/features/draft-review/review-changes";
import {
  accountEpochIs,
  answerDraftCommandClosed,
  answerDraftSelection,
  beginChangeCommand,
  beginDraftCommand,
  beginIntentDrain,
  type ChangeFailureCode,
  type ChangeSelection,
  claimIsLive,
  confirmChangeCommand,
  confirmDraftCommand,
  currentAccountEpoch,
  currentChangeCommandRecords,
  currentDraftCommandRecords,
  type DraftClaim,
  type DraftCommandFailure,
  type DraftRef,
  endIntentDrain,
  failChangeCommand,
  failDraftCommand,
  intentDrainCurrent,
  intentKeys,
  nextQueuedClick,
  pendingDraftCommand,
  queueChangeSelection,
  queuedChangeIsLive,
  queueWholeDraft,
  releaseDraftCommand,
  selectionKeys,
  wholeDraftPending,
} from "./draft-command-record";
import { classifyDraftCommandRejection } from "./draft-command-rejection";
import { projectDraft } from "./draft-projection";
import { isProjectContextCatalogKey, projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { draftPreviewQueryOptions } from "./useDraftPreview";

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

/**
 * Claim and connectivity are decided together, before the caller takes
 * optimistic UI effects. Every claim belongs to just this draft.
 */
export function startDraftCommand(
  queryClient: QueryClient,
  command: DraftCommand,
  threadId: string | null = null,
  onSent?: () => void,
): CommandStart {
  const { draft, mode } = command;
  const blocked = {
    sent: false,
    outcome: Promise.resolve<DraftCommandOutcome>({ kind: "blocked" }),
  };
  if (pendingDraftCommand(currentDraftCommandRecords(), draft)) return blocked;
  if (!canSendDraftCommand()) {
    const by = draft;
    const outcome: DraftCommandOutcome =
      command.target === "all"
        ? { kind: "failed", failure: { code: `${mode}-offline` } }
        : { kind: "change-refused", mode, code: "offline" };
    if (command.target === "all" && outcome.kind === "failed")
      failDraftCommand(by, outcome.failure);
    else if (command.target === "selection")
      failChangeCommand(by, command.selection, mode, "offline");
    releaseDraftCommand(by);
    return { sent: false, outcome: Promise.resolve(outcome) };
  }
  const claim =
    command.target === "all"
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
        );
  if (!claim) return blocked;
  try {
    onSent?.();
  } catch (error) {
    releaseDraftCommand(claim);
    return { sent: false, outcome: Promise.reject(error) };
  }
  return { sent: true, outcome: execute(queryClient, command, threadId, claim) };
}

async function execute(
  queryClient: QueryClient,
  command: DraftCommand,
  threadId: string | null,
  claim: DraftClaim,
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
          if (!claimIsLive(claim)) throw new Error("Draft command capability revoked");
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
    if (!claimIsLive(claim)) return { kind: "blocked" };
    if (response.status === "applied" || response.status === "discarded") {
      if (command.target === "all" || ("draftClosed" in response && response.draftClosed))
        answerDraftCommandClosed(claim, {
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
        const live = claimIsLive(claim);
        confirmDraftCommand(claim);
        if (live)
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
      if (!accountEpochIs(claim.epoch)) return { kind: "blocked" };
      return { kind: mode === "apply" ? "applied" : "discarded" };
    }
    const confirmed = response.status === (mode === "apply" ? "applied" : "discarded");
    if (confirmed || response.status === "gone") {
      answerDraftSelection(
        claim,
        response.status === "gone" ? "change-gone" : mode === "apply" ? "applied" : "discarded",
      );
      // Keep the claim while reads settle; then prune their result and fence older reads.
      await refreshDraft();
      if (!claimIsLive(claim)) return { kind: "blocked" };
      confirmChangeCommand(claim, command.selection, mode);
      return confirmed
        ? { kind: "change-settled", mode }
        : { kind: "change-refused", mode, code: "gone" };
    }
    await refreshDraft();
    if (!claimIsLive(claim)) return { kind: "blocked" };
    const code = "stale";
    failChangeCommand(claim, command.selection, mode, code);
    return { kind: "change-refused", mode, code };
  } catch (error) {
    if (!claimIsLive(claim)) return { kind: "blocked" };
    if (command.target === "all" && mode === "apply") void refreshDraft().catch(() => undefined);
    else await refreshDraft().catch(() => undefined);
    if (!claimIsLive(claim)) return { kind: "blocked" };
    const unknown =
      httpErrorStatus(error) === undefined && (command.target === "selection" || mode === "apply");
    const rejection = classifyDraftCommandRejection(error);
    if (command.target === "selection") {
      const code = unknown ? "unknown" : rejection.kind;
      failChangeCommand(
        claim,
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
    failDraftCommand(claim, failure);
    return unknown ? { kind: "apply-outcome-unknown" } : { kind: "failed", failure };
  } finally {
    releaseDraftCommand(claim);
  }
}

/**
 * One click on a change's Apply or Discard. It is accepted at once and shown
 * (the change leaves every surface); clicks on a draft are sent one at a time,
 * each resolved against the draft as it is when its turn comes, so a Discard
 * that re-forked the draft never leaves the next click holding the old
 * generation's rows or tokens. The queue entry is the click's capability: it
 * carries the account epoch and the caller's promise, and an account change
 * answers it `blocked` before anything is sent for it.
 */
export function runDraftSelection(
  queryClient: QueryClient,
  scope: Scope,
  mode: Mode,
  draft: DraftReviewSelection,
  selection: ChangeSelection,
  threadId: string | null,
): Promise<DraftCommandOutcome> {
  if (!selection.operationIds.length) return Promise.resolve({ kind: "blocked" });
  const target = { ...scope, documentId: draft.documentId, draftId: draft.draftId };
  if (wholeDraftPending(currentChangeCommandRecords(), target))
    return Promise.resolve({ kind: "blocked" });
  if (cachedActivePreview(queryClient, target) === null)
    return Promise.resolve({ kind: "change-refused", mode, code: "stale" });
  return new Promise<DraftCommandOutcome>((resolve) => {
    queueChangeSelection(target, selection, mode, resolve);
    void drainClicks(queryClient, target, threadId);
  });
}

function cachedActivePreview(queryClient: QueryClient, draft: DraftRef) {
  const cached = queryClient.getQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.draftId,
    ),
  );
  return cached?.status === "active" ? cached : null;
}

/** Sends a draft's accepted clicks in order; the first one's claim begins in the click's own turn. */
async function drainClicks(
  queryClient: QueryClient,
  draft: DraftRef,
  threadId: string | null,
): Promise<void> {
  const token = beginIntentDrain(draft);
  if (!token) return;
  try {
    for (let sent = 0; ; sent += 1) {
      const click = nextQueuedClick(draft);
      if (!click) return;
      let outcome: DraftCommandOutcome | null;
      try {
        outcome =
          click.target === "all"
            ? queuedChangeIsLive(click.change)
              ? await click.send()
              : { kind: "blocked" }
            : await sendClick(queryClient, draft, click, threadId, sent > 0);
      } catch (error) {
        // A failed read is the click's to report only while the click is still this account's.
        if (queuedChangeIsLive(click.change) && click.target === "selection")
          failChangeCommand(draft, click, click.mode, "stale");
        if (click.target === "all") {
          click.reject(error);
          outcome = null;
        } else outcome = { kind: "change-refused", mode: click.mode, code: "stale" };
      }
      click.change.retire();
      if (outcome) click.settle(outcome);
      // An account change emptied the queue under this loop: it ends with it.
      if (!intentDrainCurrent(draft, token)) return;
    }
  } finally {
    endIntentDrain(draft, token);
  }
}

async function sendClick(
  queryClient: QueryClient,
  draft: DraftRef,
  click: Extract<NonNullable<ReturnType<typeof nextQueuedClick>>, { target: "selection" }>,
  threadId: string | null,
  afterAnother: boolean,
): Promise<DraftCommandOutcome> {
  const { mode } = click;
  const blocked: DraftCommandOutcome = { kind: "blocked" };
  // The first click is read against what the writer is looking at; a later one
  // against the draft as the earlier commands left it.
  let preview = cachedActivePreview(queryClient, draft);
  if (afterAnother && canSendDraftCommand()) {
    const fresh = await queryClient.fetchQuery({
      ...draftPreviewQueryOptions(draft),
      staleTime: 0,
    });
    // Revoked while the read was out: nothing is sent, nothing is published.
    if (!queuedChangeIsLive(click.change)) return blocked;
    preview = fresh.status === "active" ? fresh : null;
  }
  if (!preview) return { kind: "change-refused", mode, code: "gone" };
  // Raw evidence also contains already-settled operations in an older cache.
  // Only confirmed intents are projected here: queued clicks still contribute
  // to whether this command completes the draft.
  const remaining = projectDraft(
    preview,
    intentKeys(currentChangeCommandRecords(), draft, true),
    false,
  ).preview;
  if (remaining.status !== "active") return { kind: "change-refused", mode, code: "gone" };
  const changes = reviewChangesOfPreview(remaining);
  // The change is found again in this draft by what it is (its keys) and sent as
  // the rows this generation names. A draft that holds nothing of it is gone:
  // no row of another generation is ever sent in its place.
  const wanted = new Set(selectionKeys(click));
  const current = changes.filter((change) => change.keys.some((key) => wanted.has(key)));
  if (current.length === 0) return { kind: "change-refused", mode, code: "gone" };
  const selection = selectionOf(current);
  const start = startDraftCommand(
    queryClient,
    {
      target: "selection",
      draft,
      mode,
      selection,
      basis: {
        liveRevisionToken: preview.liveRevisionToken,
        draftRevisionToken: preview.draftRevisionToken,
        draftGeneration: preview.draftGeneration,
      },
      completesDraft: coversEveryChange(selection, changes),
    },
    threadId,
  );
  // Its claim hides the change from here on; the queue entry's hiding ends with it.
  click.change.retire();
  return start.outcome;
}

export type DraftBatchItem = { draft: DraftReviewSelection };
export type DraftBatchOutcome = { draft: DraftReviewSelection; outcome: DraftCommandOutcome };

/**
 * A batch is aggregate progress, not another scheduler. Each send submits to
 * its own draft's admission/queue; unrelated drafts remain actionable. The
 * account capability is checked before every next submission.
 */
export async function runDraftBatch<T extends DraftBatchItem>(
  items: readonly T[],
  send: (item: T) => Promise<DraftCommandOutcome>,
): Promise<DraftBatchOutcome[]> {
  const epoch = currentAccountEpoch();
  const outcomes: DraftBatchOutcome[] = [];
  // Offline clicks refuse now, never become delayed work on reconnect.
  const offline = !canSendDraftCommand();
  for (const item of items) {
    const outcome = !accountEpochIs(epoch)
      ? { kind: "blocked" as const }
      : offline && canSendDraftCommand()
        ? { kind: "blocked" as const }
        : await send(item);
    outcomes.push({ draft: item.draft, outcome });
  }
  return outcomes;
}

/** Whole and selective batch targets share the draft's one epoch-bound drain. */
export function runWholeDraftIntent(
  queryClient: QueryClient,
  draft: DraftRef,
  mode: Mode,
  send: () => CommandStart,
  threadId: string | null,
): CommandStart {
  let admitted: CommandStart | null = null;
  const outcome = new Promise<DraftCommandOutcome>((resolve, reject) => {
    queueWholeDraft(
      draft,
      mode,
      () => {
        const start = send();
        admitted = start;
        return start.outcome;
      },
      resolve,
      reject,
    );
    void drainClicks(queryClient, draft, threadId);
  });
  // The drain admits an idle draft synchronously. Queued whole commands do not
  // grant immediate navigation; their onSent effect belongs to their own turn.
  return { sent: (admitted as CommandStart | null)?.sent ?? false, outcome };
}
