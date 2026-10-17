/** Admission and settlement of typed draft commands; records own their cross-surface lifetime. */
import type {
  DraftApplyAllResponse,
  DraftApplyChangesRequest,
  DraftApplyChangesResponse,
  DraftApplyHttpResponse,
  DraftApplyPendingResponse,
  DraftApplyRefusalBody,
  DraftApplyRequest,
  DraftDiscardAllResponse,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ThreadDraftListItem,
} from "@meridian/contracts/drafts";
import { MAX_DISCARD_MEMBER_PART_KEYS } from "@meridian/contracts/drafts";
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import {
  applyAllDrafts,
  applyDraft,
  applyDraftChanges,
  discardAllDrafts,
  discardDraft,
  observeDraftCommand,
} from "@/client/api/drafts-api";
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
  commandIdFor,
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
  type QueuedChange,
  queueChangeSelection,
  queuedChangeIsLive,
  queueWholeDraft,
  rebaseChangeCommand,
  releaseDraftCommand,
  retainUnknownCommand,
  selectionKeys,
  wholeDraftPending,
} from "./draft-command-record";
import { classifyDraftCommandRejection } from "./draft-command-rejection";
import { settleCommand } from "./draft-command-transport";
import { bumpDraftLinkEpoch } from "./draft-link-epoch";
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
  branchGeneration: number;
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
  itemKey: string,
): string | null {
  return (
    queryClient
      .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(projectId, workId))
      ?.find((item) => item.itemKey === itemKey)?.documentName ?? null
  );
}

export function newestKnownProposal(queryClient: QueryClient, draft: DraftRef): number | undefined {
  const cached = queryClient.getQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.itemKey,
    ),
  );
  const row = queryClient
    .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(draft.projectId, draft.workId))
    ?.find((item) => item.itemKey === draft.itemKey);
  const known = [
    cached?.status === "active" && reviewChangesOfPreview(cached).length > 0
      ? cached.branchGeneration
      : undefined,
    row?.branchGeneration,
  ].filter((generation) => typeof generation === "number");
  return known.length ? Math.max(...known) : undefined;
}

/**
 * The one draft-read invalidation: hints, lists, previews and link answers all
 * re-read after any command. `documentId` narrows previews to one document;
 * a Work-wide command omits it and refreshes every document's.
 */
function refresh(
  queryClient: QueryClient,
  scope: Scope & { documentId?: string },
  threadId: string | null,
  preview = true,
): Promise<void> {
  bumpDraftLinkEpoch(scope.projectId);
  if (threadId) {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.threads(scope.projectId) });
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.documentDraftHintsOf(scope.projectId),
  });
  const documents = ["projects", scope.projectId, "works", scope.workId, "documents"];
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: projectQueryKeys.workDrafts(scope.projectId, scope.workId),
    }),
    preview
      ? queryClient.invalidateQueries({
          queryKey: scope.documentId ? [...documents, scope.documentId, "draft"] : documents,
        })
      : Promise.resolve(),
  ]).then(() => undefined);
}

/** Everything one command's request can answer, before and after the server finishes it. */
type CommandWire =
  | DraftApplyHttpResponse
  | DraftApplyRefusalBody
  | DraftApplyChangesResponse
  | DraftDiscardResponse;
type CommandResult = Exclude<CommandWire, DraftApplyPendingResponse>;
type CommandSettlement = Awaited<ReturnType<typeof settleCommand<CommandResult>>>;
type CommandBody<T> = T extends unknown ? Omit<T, "commandId"> : never;
type ApplyBody = DraftApplyRequest;
type ApplyChangesBody = DraftApplyChangesRequest;
type DiscardBody = DraftDiscardRequest;

function listedRow(queryClient: QueryClient, draft: DraftRef): ThreadDraftListItem | undefined {
  return queryClient
    .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(draft.projectId, draft.workId))
    ?.find((item) => item.itemKey === draft.itemKey);
}

/** The draft the item belongs to, from the preview the writer is reading, else the list row. */
function draftIdOf(
  queryClient: QueryClient,
  draft: DraftRef,
  row: ThreadDraftListItem | undefined,
): string | null {
  const preview = queryClient.getQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.itemKey,
    ),
  );
  // A corrupt preview carries draftId so an unlisted item can still be discarded.
  const previewed =
    preview?.status === "active" || preview?.status === "corrupt" ? preview.draftId : undefined;
  return previewed ?? row?.draftId ?? null;
}

/** The command's request without its id: what a resend repeats byte for byte. */
function requestBody(
  command: DraftCommand,
  draftId: string,
  row: ThreadDraftListItem | undefined,
): CommandBody<ApplyBody | ApplyChangesBody | DiscardBody> {
  const { itemKey } = command.draft;
  if (command.target === "all")
    return command.mode === "apply"
      ? { draftId, itemKey, ...(row ? row.tokens : {}) }
      : { draftId, itemKey };
  const basis = {
    draftId,
    itemKey,
    liveRevisionToken: command.basis.liveRevisionToken,
    draftRevisionToken: command.basis.draftRevisionToken,
  };
  return command.mode === "apply"
    ? { ...basis, operationIds: [...command.selection.operationIds] }
    : {
        ...basis,
        closureClassIds: [...command.selection.classIds],
        admissionTokens: [...command.selection.admissionTokens],
        // Retained clicked operationKey values are part keys, except row-only fallbacks.
        memberPartKeys: evenSample(
          selectionKeys(command.selection).filter((key) => !key.startsWith("row:")),
          MAX_DISCARD_MEMBER_PART_KEYS,
        ),
      };
}

/**
 * At most `limit` of `keys`, evenly spaced and in order, so a resend repeats the same bytes.
 * Members only tell a vanished class that grew from one that is gone, which a sample answers.
 */
function evenSample(keys: readonly string[], limit: number): string[] {
  if (keys.length <= limit) return [...keys];
  return Array.from(
    { length: limit },
    (_, index) => keys[Math.floor((index * keys.length) / limit)] as string,
  );
}

/** The server code a refused item command carries to the render layer. */
function refusalCode(response: CommandResult): string {
  if (response.status === "held") return response.reason.code;
  return response.status === "gone" ? "draft_not_found" : response.status;
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
  retryStale?: () => Promise<DraftCommand | null>,
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
          branchGeneration: command.generation,
          ...(command.completesDraft ? { completesDraft: true } : {}),
        })
      : beginChangeCommand(
          draft,
          command.selection,
          mode,
          command.basis.branchGeneration,
          command.completesDraft,
        );
  if (!claim) return blocked;
  try {
    onSent?.();
  } catch (error) {
    releaseDraftCommand(claim);
    return { sent: false, outcome: Promise.reject(error) };
  }
  return { sent: true, outcome: execute(queryClient, command, threadId, claim, retryStale) };
}

async function execute(
  queryClient: QueryClient,
  command: DraftCommand,
  threadId: string | null,
  claim: DraftClaim,
  retryStale?: () => Promise<DraftCommand | null>,
): Promise<DraftCommandOutcome> {
  const { draft, mode } = command;
  const refreshDraft = () => refresh(queryClient, draft, threadId);
  let held: { commandId: string; digest: string } | null = null;
  try {
    if (command.target === "all" && mode === "apply")
      void queryClient.cancelQueries({
        queryKey: projectQueryKeys.workDrafts(draft.projectId, draft.workId),
      });
    const row = listedRow(queryClient, draft);
    const draftId = draftIdOf(queryClient, draft, row);
    const body = draftId ? requestBody(command, draftId, row) : null;
    const digest = JSON.stringify(body);
    const kind = `${command.target}-${mode}`;
    const commandId = commandIdFor(draft, kind, digest);
    // The body is frozen from here: every resend of this command carries this id and these bytes.
    const request = { ...body, commandId };
    const send = (): Promise<CommandWire> => {
      if (!claimIsLive(claim)) throw new Error("Draft command capability revoked");
      if (!body) return Promise.resolve({ status: "gone", draftId: "", itemKey: draft.itemKey });
      if (command.target === "all")
        return mode === "apply"
          ? applyDraft(draft.projectId, draft.workId, draft.documentId, request as ApplyBody)
          : discardDraft(draft.projectId, draft.workId, draft.documentId, request as DiscardBody);
      return mode === "apply"
        ? applyDraftChanges(
            draft.projectId,
            draft.workId,
            draft.documentId,
            request as ApplyChangesBody,
          )
        : discardDraft(draft.projectId, draft.workId, draft.documentId, request as DiscardBody);
    };
    held = { commandId, digest };
    // TanStack is the request adapter, never an offline queue.
    const settled = await queryClient
      .getMutationCache()
      .build<CommandSettlement, unknown, void, unknown>(queryClient, {
        networkMode: "always",
        mutationFn: () =>
          settleCommand<CommandResult>({
            send,
            observe: () => observeDraftCommand(draft.projectId, draft.workId, commandId),
            live: () => claimIsLive(claim),
          }),
      })
      .execute(undefined);
    if (!claimIsLive(claim)) return { kind: "blocked" };
    held = null;
    retainUnknownCommand(draft, kind, null);
    if (settled.kind === "revoked") return { kind: "blocked" };
    if (settled.kind === "blocked") {
      await refreshDraft().catch(() => undefined);
      if (!claimIsLive(claim)) return { kind: "blocked" };
      if (command.target === "all") {
        const failure: DraftCommandFailure = { code: "apply-blocked" };
        failDraftCommand(claim, failure);
        return { kind: "failed", failure };
      }
      failChangeCommand(claim, command.selection, mode, "blocked");
      return { kind: "change-refused", mode, code: "blocked" };
    }
    const wire = settled.result;
    const response =
      wire.status === "applied" && "item" in wire && wire.item.status === "held"
        ? {
            status: "held" as const,
            draftId: wire.draftId,
            itemKey: wire.itemKey,
            reason: wire.item.reason,
          }
        : wire;
    if (
      command.target === "all" &&
      response.status !== "applied" &&
      response.status !== "discarded"
    ) {
      await refreshDraft().catch(() => undefined);
      if (!claimIsLive(claim)) return { kind: "blocked" };
      const failure: DraftCommandFailure = {
        code: `${mode}-refused`,
        serverCode: refusalCode(response),
      };
      failDraftCommand(claim, failure);
      return { kind: "failed", failure };
    }
    if (response.status === "applied" || response.status === "discarded") {
      if (command.target === "all" || ("itemClosed" in response && response.itemClosed))
        answerDraftCommandClosed(claim, {
          documentName: listedDocumentName(
            queryClient,
            draft.projectId,
            draft.workId,
            draft.itemKey,
          ),
        });
    }
    if (command.target === "all") {
      if (mode === "apply") {
        confirmDraftCommand(claim);
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
      // Keep the claim while reads settle; confirmed intent projects older raw observations.
      await refreshDraft();
      if (!claimIsLive(claim)) return { kind: "blocked" };
      confirmChangeCommand(claim, command.selection, mode);
      return confirmed
        ? { kind: "change-settled", mode }
        : { kind: "change-refused", mode, code: "gone" };
    }
    await refresh(queryClient, draft, threadId, !retryStale);
    if (!claimIsLive(claim)) return { kind: "blocked" };
    if (response.status === "stale" && retryStale) {
      // An explicit stale response proved non-acceptance. A failed fresh read
      // refuses this intent; it is not an ambiguous mutation outcome.
      const retry = await retryStale().catch(() => null);
      if (!claimIsLive(claim)) return { kind: "blocked" };
      if (retry?.target === "selection") {
        rebaseChangeCommand(
          claim,
          retry.selection,
          retry.basis.branchGeneration,
          retry.completesDraft,
        );
        return await execute(queryClient, retry, threadId, claim);
      }
    }
    const code = "stale";
    failChangeCommand(claim, command.selection, mode, code);
    return { kind: "change-refused", mode, code };
  } catch (error) {
    if (!claimIsLive(claim)) return { kind: "blocked" };
    if (command.target === "all" && mode === "apply") void refreshDraft().catch(() => undefined);
    else await refreshDraft().catch(() => undefined);
    if (!claimIsLive(claim)) return { kind: "blocked" };
    const unknown = httpErrorStatus(error) === undefined;
    retainUnknownCommand(draft, `${command.target}-${mode}`, unknown ? held : null);
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
      ? { code: `${mode}-unknown` }
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
  const target = { ...scope, documentId: draft.documentId, itemKey: draft.itemKey };
  if (wholeDraftPending(currentChangeCommandRecords(), target))
    return Promise.resolve({ kind: "blocked" });
  if (cachedActivePreview(queryClient, target) === null)
    return Promise.resolve({ kind: "change-refused", mode, code: "stale" });
  return new Promise<DraftCommandOutcome>((resolve) => {
    queueChangeSelection(target, selection, mode, resolve, (click, afterAnother) =>
      sendClick(queryClient, target, mode, click, threadId, afterAnother),
    );
    void drainClicks(target);
  });
}

function cachedActivePreview(queryClient: QueryClient, draft: DraftRef) {
  const cached = queryClient.getQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.itemKey,
    ),
  );
  return cached?.status === "active" ? cached : null;
}

/** Sends a draft's accepted clicks in order; the first one's claim begins in the click's own turn. */
async function drainClicks(draft: DraftRef): Promise<void> {
  const token = beginIntentDrain(draft);
  if (!token) return;
  try {
    for (let sent = 0; ; sent += 1) {
      const click = nextQueuedClick(draft);
      if (!click) return;
      let outcome: DraftCommandOutcome | null;
      try {
        if (click.target === "all") {
          if (queuedChangeIsLive(click.change)) {
            // Admission transfers the intent to its addressed claim, as for selections.
            click.change.retire();
            outcome = await click.send();
          } else outcome = { kind: "blocked" };
        } else outcome = await click.send(click, sent > 0);
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
  mode: Mode,
  click: ChangeSelection & { change: QueuedChange },
  threadId: string | null,
  afterAnother: boolean,
): Promise<DraftCommandOutcome> {
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
  const resolved = resolveClick(preview, draft, click);
  if (!resolved) {
    failChangeCommand(draft, click, mode, "stale");
    return { kind: "change-refused", mode, code: "stale" };
  }
  const { selection, changes } = resolved;
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
        branchGeneration: preview.branchGeneration,
      },
      completesDraft: coversEveryChange(selection, changes),
    },
    threadId,
    undefined,
    async () => {
      const fresh = await queryClient.fetchQuery({
        ...draftPreviewQueryOptions(draft),
        staleTime: 0,
      });
      if (
        !accountEpochIs(click.change.epoch) ||
        !canSendDraftCommand() ||
        fresh.status !== "active"
      )
        return null;
      const resolved = resolveClick(fresh, draft, click);
      return resolved
        ? {
            target: "selection",
            draft,
            mode,
            selection: resolved.selection,
            basis: {
              liveRevisionToken: fresh.liveRevisionToken,
              draftRevisionToken: fresh.draftRevisionToken,
              branchGeneration: fresh.branchGeneration,
            },
            completesDraft: coversEveryChange(resolved.selection, resolved.changes),
          }
        : null;
    },
  );
  // Its claim hides the change from here on; the queue entry's hiding ends with it.
  click.change.retire();
  return start.outcome;
}

/** Focus follows overlap; commands retain the clicked members and their server admission evidence. */
function resolveClick(
  preview: Extract<DraftPreviewResponse, { status: "active" }>,
  draft: DraftRef,
  click: ChangeSelection,
) {
  const remaining = projectDraft(
    preview,
    intentKeys(currentChangeCommandRecords(), draft, true),
    false,
  ).preview;
  if (remaining.status !== "active") return null;
  const changes = reviewChangesOfPreview(remaining);
  const wanted = new Set(selectionKeys(click));
  // Membership is checked on complete raw classes, never on masked evidence.
  const current = reviewChangesOfPreview(preview).filter((change) =>
    change.keys.some((key) => wanted.has(key)),
  );
  if (!current.length || current.some((change) => change.target.kind !== "operations")) return null;
  const selection = selectionOf(current);
  const expectedTokens = new Set(click.admissionTokens);
  if (
    expectedTokens.size !== selection.admissionTokens.length ||
    selection.admissionTokens.some((token) => !expectedTokens.has(token))
  )
    return null;
  const found = new Set(selectionKeys(selection));
  if (found.size !== wanted.size || [...found].some((key) => !wanted.has(key))) return null;
  return { changes, selection: { ...selection, keys: [...selectionKeys(click)] } };
}

export type DraftBatchItem = { draft: DraftReviewSelection };
export type DraftBatchOutcome = { draft: DraftReviewSelection; outcome: DraftCommandOutcome };

/**
 * A batch is aggregate progress, not another scheduler. Each send submits to
 * its own draft's admission/queue; unrelated drafts remain actionable. The
 * account capability is checked by each queue at actual send.
 */
export async function runDraftBatch<T extends DraftBatchItem>(
  items: readonly T[],
  send: (item: T) => Promise<DraftCommandOutcome>,
): Promise<DraftBatchOutcome[]> {
  const epoch = currentAccountEpoch();
  // Admission is synchronous for every target. Their draft queues, not this
  // aggregate, own dispatch and account revocation before an actual send.
  const pending = items.map((item) => {
    const outcome = accountEpochIs(epoch)
      ? send(item)
      : Promise.resolve<DraftCommandOutcome>({ kind: "blocked" });
    return outcome.then((outcome) => ({ draft: item.draft, outcome }));
  });
  return Promise.all(pending);
}

/** Whole and selective batch targets share the draft's one epoch-bound drain. */
export function runWholeDraftIntent(
  draft: DraftRef,
  mode: Mode,
  send: () => CommandStart,
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
    void drainClicks(draft);
  });
  // The drain admits an idle draft synchronously. Queued whole commands do not
  // grant immediate navigation; their onSent effect belongs to their own turn.
  return { sent: (admitted as CommandStart | null)?.sent ?? false, outcome };
}

/**
 * Work Files' Apply all and Discard all: one server command over the Work's listed items. Each item
 * the command acts on takes its own claim (it leaves every surface at the click and locks its
 * selective controls) and settles from the one answer: applied or discarded, held or stale on that item.
 * An item whose own command is in flight is left to that command.
 */
export function runWorkWideCommand(
  queryClient: QueryClient,
  scope: Scope,
  mode: Mode,
  drafts: readonly DraftReviewSelection[],
  threadId: string | null,
  onSent?: (claimed: readonly DraftReviewSelection[]) => void,
): Promise<DraftCommandOutcome[]> {
  const blocked: DraftCommandOutcome = { kind: "blocked" };
  const rows = queryClient.getQueryData<ThreadDraftListItem[]>(
    projectQueryKeys.workDrafts(scope.projectId, scope.workId),
  );
  const targets = drafts.flatMap((draft) => {
    const row = rows?.find((item) => item.itemKey === draft.itemKey);
    return row ? [{ draft: { ...scope, ...draft }, row }] : [];
  });
  const draftId = targets[0]?.row.draftId;
  const claimable = (draft: DraftRef) =>
    !pendingDraftCommand(currentDraftCommandRecords(), draft) &&
    !wholeDraftPending(currentChangeCommandRecords(), draft);
  if (!draftId || !targets.some(({ draft }) => claimable(draft)))
    return Promise.resolve(drafts.map(() => blocked));
  if (!canSendDraftCommand()) {
    const failure: DraftCommandFailure = { code: `${mode}-offline` };
    for (const { draft } of targets) if (claimable(draft)) failDraftCommand(draft, failure);
    return Promise.resolve(drafts.map(() => ({ kind: "failed", failure })));
  }
  const claims = targets.flatMap(({ draft, row }) => {
    const claim = claimable(draft)
      ? beginDraftCommand(draft, {
          target: "all",
          mode,
          branchGeneration: row.branchGeneration ?? undefined,
          completesDraft: true,
        })
      : null;
    return claim ? [{ claim, row }] : [];
  });
  try {
    onSent?.(claims.map(({ claim }) => claim.draft));
  } catch (error) {
    for (const { claim } of claims) releaseDraftCommand(claim);
    return Promise.reject(error);
  }
  return executeWorkWide(queryClient, scope, mode, draftId, claims, threadId).then((byKey) =>
    drafts.map((draft) => byKey.get(draft.itemKey) ?? blocked),
  );
}

async function executeWorkWide(
  queryClient: QueryClient,
  scope: Scope,
  mode: Mode,
  draftId: string,
  claims: readonly { claim: DraftClaim; row: ThreadDraftListItem }[],
  threadId: string | null,
): Promise<Map<string, DraftCommandOutcome>> {
  const outcomes = new Map<string, DraftCommandOutcome>();
  let held: { commandId: string; digest: string } | null = null;
  const live = () => claims.some(({ claim }) => claimIsLive(claim));
  const refreshWork = () => refresh(queryClient, scope, threadId);
  const settle = (
    each: (claim: DraftClaim, row: ThreadDraftListItem) => DraftCommandOutcome | null,
  ) => {
    for (const { claim, row } of claims) {
      if (!claimIsLive(claim)) continue;
      const outcome = each(claim, row);
      if (outcome) outcomes.set(row.itemKey, outcome);
    }
  };
  const fail = (code: DraftCommandFailure["code"], serverCode?: string) =>
    settle((claim) => {
      const failure: DraftCommandFailure = { code, ...(serverCode ? { serverCode } : {}) };
      failDraftCommand(claim, failure);
      return { kind: "failed", failure };
    });
  const closed = (claim: DraftClaim, row: ThreadDraftListItem) =>
    answerDraftCommandClosed(claim, { documentName: row.documentName });
  try {
    if (mode === "apply")
      void queryClient.cancelQueries({
        queryKey: projectQueryKeys.workDrafts(scope.projectId, scope.workId),
      });
    const items = claims.map(({ row }) => ({
      itemKey: row.itemKey,
      locationToken: row.tokens.locationToken,
      ...(row.tokens.liveTextToken ? { liveTextToken: row.tokens.liveTextToken } : {}),
      ...(row.tokens.branchGenerationToken
        ? { branchGenerationToken: row.tokens.branchGenerationToken }
        : {}),
    }));
    const digest = JSON.stringify(items);
    const commandId = commandIdFor(claims[0].claim.draft, `work-${mode}`, digest);
    held = { commandId, digest };
    const settled = await queryClient
      .getMutationCache()
      .build<
        Awaited<ReturnType<typeof settleCommand<DraftApplyAllResponse | DraftDiscardAllResponse>>>,
        unknown,
        void,
        unknown
      >(queryClient, {
        networkMode: "always",
        mutationFn: () =>
          settleCommand<DraftApplyAllResponse | DraftDiscardAllResponse>({
            send: () =>
              mode === "apply"
                ? applyAllDrafts(scope.projectId, scope.workId, { draftId, commandId, items })
                : discardAllDrafts(scope.projectId, scope.workId, { draftId, commandId }),
            observe: () => observeDraftCommand(scope.projectId, scope.workId, commandId),
            live,
          }),
      })
      .execute(undefined);
    if (settled.kind === "revoked") return outcomes;
    retainUnknownCommand(claims[0].claim.draft, `work-${mode}`, null);
    if (settled.kind === "blocked") {
      await refreshWork().catch(() => undefined);
      fail("apply-blocked");
      return outcomes;
    }
    const response = settled.result;
    if (response.status === "completed") {
      const byKey = new Map(response.items.map((item) => [item.itemKey, item]));
      settle((claim, row) => {
        const item = byKey.get(row.itemKey);
        if (item?.status === "applied") {
          closed(claim, row);
          confirmDraftCommand(claim);
          return { kind: "applied" };
        }
        const failure: DraftCommandFailure = {
          code: "apply-refused",
          serverCode: item?.status === "held" ? item.reason.code : "stale",
        };
        failDraftCommand(claim, failure);
        return { kind: "failed", failure };
      });
      void queryClient
        .invalidateQueries({
          predicate: (query) => isProjectContextCatalogKey(query.queryKey, scope.projectId),
        })
        .catch(() => undefined);
      await refreshWork().catch(() => undefined);
    } else if (response.status === "discarded") {
      settle((claim, row) => {
        closed(claim, row);
        return { kind: "discarded" };
      });
      await refreshWork().catch(() => undefined);
    } else if (response.status === "stale") {
      const stale = new Set<string>(response.staleItemKeys);
      await refreshWork().catch(() => undefined);
      settle((claim, row) => {
        if (!stale.has(row.itemKey)) return { kind: "blocked" };
        const failure: DraftCommandFailure = { code: "apply-refused", serverCode: "stale" };
        failDraftCommand(claim, failure);
        return { kind: "failed", failure };
      });
    } else {
      await refreshWork().catch(() => undefined);
      fail(`${mode}-refused`, "draft_not_found");
    }
    return outcomes;
  } catch (error) {
    const unknown = httpErrorStatus(error) === undefined;
    retainUnknownCommand(claims[0].claim.draft, `work-${mode}`, unknown ? held : null);
    await refreshWork().catch(() => undefined);
    if (unknown) fail(`${mode}-unknown`);
    else {
      const rejection = classifyDraftCommandRejection(error);
      fail(
        `${mode}-${rejection.kind}`,
        rejection.kind === "refused" ? rejection.serverCode : undefined,
      );
    }
    return outcomes;
  } finally {
    for (const { claim } of claims) releaseDraftCommand(claim);
  }
}
