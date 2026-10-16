/**
 * Draft commands that reach the server: Apply (a change, a selection, or the whole item), item Discard,
 * and the Work page's Apply all and Discard all. A review's own Discard is a local editor edit
 * (`draft-discard.ts`) and never comes here.
 *
 * The click is optimistic: the changes leave the screen when Apply is sent and come back with the error
 * on them when the server refuses. Records own that state (`draft-command-record`); this module decides
 * what each answer means. Every command is one `commandId` with one frozen body, carried to its terminal
 * answer by `settleCommand` (resends, 202 observation, blocked), so a lost request or a slow batch never
 * applies twice.
 */
import type {
  DraftApplyAllBody,
  DraftApplyAllResult,
  DraftApplyChangesBody,
  DraftApplyItemBody,
  DraftApplyPendingResponse,
  DraftCommandObservation,
  DraftDiscardAllResponse,
  DraftItemApplyResult,
  DraftItemDiscardResult,
  DraftItemOutcome,
  ThreadDraftListItem,
} from "@meridian/contracts/drafts";
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import {
  applyAllDrafts,
  discardAllDrafts,
  observeDraftCommand,
  applyDraft as postApplyDraft,
  applyDraftChanges as postApplyDraftChanges,
  discardDraft as postDiscardDraft,
} from "@/client/api/drafts-api";
import { httpErrorStatus } from "@/client/api/http-client";
import {
  beginChangeApply,
  beginDraftCommand,
  type ChangeClaim,
  type ChangeFailure,
  type ChangeTarget,
  changeClaimIsLive,
  claimIsLive,
  commandIdFor,
  type DraftClaim,
  type DraftCommandFailure,
  type DraftRef,
  failChangeApply,
  failDraftCommand,
  noteOverrode,
  type Overrode,
  releaseDraftCommand,
  retainUnknownCommand,
  settleChangeApply,
} from "./draft-command-record";
import { classifyDraftCommandRejection } from "./draft-command-rejection";
import { settleCommand } from "./draft-command-transport";
import { bumpDraftLinkEpoch } from "./draft-link-epoch";
import { fetchForCommand } from "./fetch-for-command";
import { isProjectContextCatalogKey, projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { draftMetaQueryOptions, isWholeItem } from "./useDraftMeta";

export type DraftCommandOutcome =
  /** Not sent: offline, a command already in flight, or the Work is frozen. */
  | { kind: "blocked" }
  /**
   * `itemClosed`: this command dropped a created item's row, so the document is an ordinary live
   * document now (contract §3.4's promote signal). Every other Apply leaves the item and its tab.
   */
  | { kind: "applied"; overrode: Overrode; itemClosed: boolean }
  | { kind: "discarded" }
  /** The item was closed elsewhere; the review exits through the gone path. */
  | { kind: "gone" }
  /** The reason is on the item or its changes (`draft-command-record`). */
  | { kind: "failed" };

/** What an Apply sends, ready once the item's room is read and the server holds everything in it. */
export type PreparedApply = {
  /** Base64 `Y.snapshot` of the item's room the changes were computed from; null for an item with no text. */
  snapshot: string | null;
  /** Resolves when the server has every update the snapshot contains; rejects if it cannot be confirmed. */
  synced: () => Promise<void>;
  /** Ends whatever the preparation held (a room read for the command). */
  release?: () => void;
};

/**
 * An Apply as its click made it. `prepare` runs inside the command's lifecycle, after the claim, so an item
 * nobody has open is read, synced and acknowledged under the same pending state and failure as the send.
 * The snapshot belongs to the frame the writer clicked: it is chosen by the click, never at send time.
 */
export type ApplyCommand = {
  draft: DraftRef;
  prepare: () => Promise<PreparedApply>;
} & ({ scope: "change"; targets: readonly ChangeTarget[]; baseKey: string } | { scope: "item" });

function canSend(): boolean {
  return navigator.onLine && onlineManager.isOnline();
}

/** Lists, the item's metadata and the chat caches that show what an item holds. */
function refresh(
  queryClient: QueryClient,
  scope: { projectId: string; workId: string; documentId?: string },
  threadId: string | null,
): void {
  bumpDraftLinkEpoch(scope.projectId);
  if (threadId) {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.threads(scope.projectId) });
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.documentDraftHintsOf(scope.projectId),
  });
  void queryClient.invalidateQueries({
    queryKey: projectQueryKeys.workDrafts(scope.projectId, scope.workId),
  });
  const documents = ["projects", scope.projectId, "works", scope.workId, "documents"];
  void queryClient.invalidateQueries({
    queryKey: scope.documentId ? [...documents, scope.documentId, "draft"] : documents,
  });
}

function listedRow(queryClient: QueryClient, draft: DraftRef): ThreadDraftListItem | undefined {
  return queryClient
    .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(draft.projectId, draft.workId))
    ?.find((item) => item.itemKey === draft.itemKey);
}

/** The draft the item belongs to: its list row, else its metadata (read if it is not held). Null: the item is closed. */
async function draftIdOf(queryClient: QueryClient, draft: DraftRef): Promise<string | null> {
  const row = listedRow(queryClient, draft);
  if (row) return row.draftId;
  const meta = await fetchForCommand(queryClient, draftMetaQueryOptions(draft));
  return meta.kind === "gone" ? null : meta.draftId;
}

/** The Work's draft row: the first listed item's. */
function workDraftId(rows: readonly ThreadDraftListItem[]): string | null {
  return rows[0]?.draftId ?? null;
}

function changeFailureOf(error: unknown): ChangeFailure {
  const rejection = classifyDraftCommandRejection(error);
  if (rejection.kind === "refused")
    return {
      code: "refused",
      serverCode: rejection.serverCode,
      serverReason: rejection.serverReason,
    };
  return { code: rejection.kind === "server-error" ? "server-error" : "unknown" };
}

function draftFailureOf(error: unknown, mode: "apply" | "discard"): DraftCommandFailure {
  const rejection = classifyDraftCommandRejection(error);
  if (rejection.kind === "refused")
    return {
      code: `${mode}-refused`,
      serverCode: rejection.serverCode,
      serverReason: rejection.serverReason,
    };
  if (rejection.kind === "server-error") return { code: `${mode}-server-error` };
  // A request the server never answered: it may have landed. Never read as offline.
  return { code: `${mode}-unknown` };
}

/** The server code a refused item or change carries to the render layer. */
function refusalCode(
  outcome: Exclude<DraftItemOutcome, { status: "applied" | "already_live" }> | ItemRefusal,
): string {
  switch (outcome.status) {
    case "held":
      return outcome.reason.code;
    case "not_found":
      return "change_not_found";
    case "failed":
      return outcome.reason;
    default:
      return outcome.status;
  }
}

/** The answers of an item route that leave the item as it was: why, as a code the render layer words. */
type ItemRefusal = Exclude<DraftItemApplyResult, { status: "applied" | "already_live" | "gone" }>;
function itemRefusalCode(result: ItemRefusal): string {
  return result.status === "stale" || result.status === "whole_item"
    ? result.status
    : refusalCode(result);
}

/** One command's body without its id (what a resend repeats byte for byte) and how it is sent. */
type Send<R> = {
  kind: string;
  body: object;
  send: (request: object) => Promise<R | DraftApplyPendingResponse>;
  observe: (commandId: string) => Promise<DraftCommandObservation | { state: "unknown" }>;
  live: () => boolean;
};

type Carried<R> =
  | { kind: "result"; result: R }
  | { kind: "blocked" }
  | { kind: "revoked" }
  | { kind: "error"; error: unknown; unknown: boolean };

/**
 * Carry one command to its answer. The id is frozen here: every resend of this command carries it and
 * these bytes. An outcome that stayed unknown keeps the id for the writer's next try of the same body.
 */
async function carry<R extends { status: string }>(
  queryClient: QueryClient,
  draft: DraftRef,
  command: Send<R>,
): Promise<Carried<R>> {
  const digest = JSON.stringify(command.body);
  const commandId = commandIdFor(draft, command.kind, digest);
  const request = { ...command.body, commandId };
  try {
    // TanStack is the request adapter, never an offline queue.
    const settled = await queryClient
      .getMutationCache()
      .build<Awaited<ReturnType<typeof settleCommand<R>>>, unknown, void, unknown>(queryClient, {
        networkMode: "always",
        mutationFn: () =>
          settleCommand<R>({
            send: () => command.send(request),
            observe: () => command.observe(commandId),
            live: command.live,
          }),
      })
      .execute(undefined);
    // Revoked while out: nothing is published, and the account's bookkeeping is not written for it.
    if (settled.kind === "revoked" || !command.live()) return { kind: "revoked" };
    retainUnknownCommand(draft, command.kind, null);
    return settled.kind === "result"
      ? { kind: "result", result: settled.result }
      : { kind: settled.kind };
  } catch (error) {
    if (!command.live()) return { kind: "revoked" };
    const unknown = httpErrorStatus(error) === undefined;
    retainUnknownCommand(draft, command.kind, unknown ? { commandId, digest } : null);
    return { kind: "error", error, unknown };
  }
}

/** What preparation produced: the snapshot to send and, for an Apply of changes, which ones. */
type Acquired = { prepared: PreparedApply; changeIds: readonly string[] | null };

/** Preparation before the send. `unsent`: the request never left, so nothing may have landed. */
type Prepared = { kind: "ready"; acquired: Acquired } | { kind: "unsent" } | { kind: "empty" };

/** Acquire, then wait for the server to hold what the snapshot contains. */
async function prepare(acquire: () => Promise<Acquired | null>): Promise<Prepared> {
  let acquired: Acquired | null;
  try {
    acquired = await acquire();
  } catch {
    return { kind: "unsent" };
  }
  if (!acquired) return { kind: "empty" };
  try {
    await acquired.prepared.synced();
  } catch {
    acquired.prepared.release?.();
    return { kind: "unsent" };
  }
  return { kind: "ready", acquired };
}

/** The item Apply request: a change route when `changeIds` names changes, else the item route. */
function applySend(
  draft: DraftRef,
  draftId: string,
  row: ThreadDraftListItem | undefined,
  acquired: Acquired,
  live: () => boolean,
  wholeItem: boolean,
): Send<DraftItemApplyResult> {
  const { itemKey } = draft;
  const { snapshot } = acquired.prepared;
  const locationToken = row?.tokens.locationToken;
  const token = locationToken ? { locationToken } : {};
  const observe = (commandId: string) =>
    observeDraftCommand(draft.projectId, draft.workId, commandId);
  // A whole-item item has one change, the item: a per-change Apply would answer `whole_item`.
  if (acquired.changeIds && snapshot && !wholeItem) {
    const body: Omit<DraftApplyChangesBody, "commandId"> = {
      draftId,
      itemKey,
      changeIds: [...acquired.changeIds],
      snapshot,
      ...token,
    };
    return {
      kind: "apply-changes",
      body,
      send: (request) =>
        postApplyDraftChanges(
          draft.projectId,
          draft.workId,
          draft.documentId,
          request as DraftApplyChangesBody,
        ),
      observe,
      live,
    };
  }
  const body: Omit<DraftApplyItemBody, "commandId"> = {
    draftId,
    itemKey,
    ...(snapshot ? { snapshot } : {}),
    ...token,
  };
  return {
    kind: "apply-item",
    body,
    send: (request) =>
      postApplyDraft(
        draft.projectId,
        draft.workId,
        draft.documentId,
        request as DraftApplyItemBody,
      ),
    observe,
    live,
  };
}

// ---- Apply of changes ----

/** Apply some changes of an item. They leave the screen now and return, with the reason on them, if they fail. */
export async function applyChanges(
  queryClient: QueryClient,
  command: ApplyCommand & { scope: "change" },
  threadId: string | null = null,
): Promise<DraftCommandOutcome> {
  const { draft, targets } = command;
  if (targets.length === 0) return { kind: "blocked" };
  const claim = beginChangeApply(draft, targets, command.baseKey);
  if (!canSend()) {
    failChangeApply(claim, { code: "offline" });
    return { kind: "blocked" };
  }
  return sendChanges(queryClient, claim, command.prepare, threadId);
}

async function sendChanges(
  queryClient: QueryClient,
  claim: ChangeClaim,
  acquire: () => Promise<PreparedApply>,
  threadId: string | null,
): Promise<DraftCommandOutcome> {
  const { draft } = claim;
  const ready = await prepare(async () => ({
    prepared: await acquire(),
    changeIds: claim.targets.map((target) => target.id),
  }));
  if (ready.kind !== "ready") {
    failChangeApply(claim, { code: "offline" });
    return { kind: "failed" };
  }
  const { acquired } = ready;
  try {
    const draftId = await draftIdOf(queryClient, draft);
    if (!draftId) {
      failChangeApply(claim, { code: "gone" });
      refresh(queryClient, draft, threadId);
      return { kind: "gone" };
    }
    const carried = await carry(
      queryClient,
      draft,
      applySend(
        draft,
        draftId,
        listedRow(queryClient, draft),
        acquired,
        () => changeClaimIsLive(claim),
        isWholeItem(queryClient, draft),
      ),
    );
    if (carried.kind === "revoked") return { kind: "blocked" };
    if (carried.kind === "blocked") {
      failChangeApply(claim, { code: "blocked" });
      refresh(queryClient, draft, threadId);
      return { kind: "failed" };
    }
    if (carried.kind === "error") {
      failChangeApply(claim, changeFailureOf(carried.error));
      return { kind: "failed" };
    }
    return answerChanges(queryClient, claim, carried.result, threadId);
  } catch (error) {
    failChangeApply(claim, changeFailureOf(error));
    return { kind: "failed" };
  } finally {
    acquired.prepared.release?.();
  }
}

function answerChanges(
  queryClient: QueryClient,
  claim: ChangeClaim,
  result: DraftItemApplyResult,
  threadId: string | null,
): DraftCommandOutcome {
  const { draft } = claim;
  switch (result.status) {
    case "applied":
    case "already_live": {
      const overrode = result.status === "applied" ? result.overrode : [];
      settleChangeApply(claim);
      noteOverrode(claim, overrode);
      refresh(queryClient, draft, threadId);
      return {
        kind: "applied",
        overrode,
        itemClosed: result.status === "applied" && result.itemClosed,
      };
    }
    case "gone":
      failChangeApply(claim, { code: "gone" });
      refresh(queryClient, draft, threadId);
      return { kind: "gone" };
    case "not_found":
      failChangeApply(claim, { code: "gone" });
      refresh(queryClient, draft, threadId);
      return { kind: "failed" };
    default:
      failChangeApply(claim, { code: "refused", serverCode: itemRefusalCode(result) });
      refresh(queryClient, draft, threadId);
      return { kind: "failed" };
  }
}

// ---- Apply of a whole item ----

/** Apply a whole item. One claim per item, taken at the click; the item stays open and empty afterwards. */
export async function applyDraft(
  queryClient: QueryClient,
  command: ApplyCommand & { scope: "item" },
  threadId: string | null = null,
): Promise<DraftCommandOutcome> {
  return applyUnderDraftClaim(
    queryClient,
    command.draft,
    async () => ({ prepared: await command.prepare(), changeIds: null }),
    threadId,
  );
}

/** What the strip's Apply finds once it has read the item: this chat's changes and the snapshot to send. */
export type ChatApplyPlan = { targets: readonly ChangeTarget[]; prepared: PreparedApply };

/**
 * Apply one chat's changes in an item nobody has open. The claim is taken at the click, so the file is
 * pending at once and a failure of reading the room, of the attribution hint or of the send lands on it;
 * `acquire` runs inside that lifecycle and what it returns is released here. Null: the chat has no change.
 */
export async function applyChatChanges(
  queryClient: QueryClient,
  draft: DraftRef,
  acquire: () => Promise<ChatApplyPlan | null>,
  threadId: string | null = null,
): Promise<DraftCommandOutcome> {
  return applyUnderDraftClaim(
    queryClient,
    draft,
    async () => {
      const plan = await acquire();
      return (
        plan && { prepared: plan.prepared, changeIds: plan.targets.map((target) => target.id) }
      );
    },
    threadId,
  );
}

async function applyUnderDraftClaim(
  queryClient: QueryClient,
  draft: DraftRef,
  acquire: () => Promise<Acquired | null>,
  threadId: string | null,
): Promise<DraftCommandOutcome> {
  const claim = beginDraftCommand(draft, "apply");
  if (!claim) return { kind: "blocked" };
  if (!canSend()) {
    failDraftCommand(claim, { code: "apply-offline" });
    return { kind: "blocked" };
  }
  const ready = await prepare(acquire);
  if (ready.kind === "empty") {
    releaseDraftCommand(claim);
    return { kind: "blocked" };
  }
  if (ready.kind === "unsent") {
    failDraftCommand(claim, { code: "apply-offline" });
    return { kind: "failed" };
  }
  const { acquired } = ready;
  try {
    const draftId = await draftIdOf(queryClient, draft);
    if (!draftId) {
      releaseDraftCommand(claim);
      refresh(queryClient, draft, threadId);
      return { kind: "gone" };
    }
    const carried = await carry(
      queryClient,
      draft,
      applySend(
        draft,
        draftId,
        listedRow(queryClient, draft),
        acquired,
        () => claimIsLive(claim),
        isWholeItem(queryClient, draft),
      ),
    );
    if (carried.kind === "revoked") return { kind: "blocked" };
    if (carried.kind === "blocked") {
      failDraftCommand(claim, { code: "apply-blocked" });
      refresh(queryClient, draft, threadId);
      return { kind: "failed" };
    }
    if (carried.kind === "error") {
      failDraftCommand(claim, draftFailureOf(carried.error, "apply"));
      return { kind: "failed" };
    }
    return answerApply(queryClient, claim, carried.result, threadId);
  } catch (error) {
    failDraftCommand(claim, draftFailureOf(error, "apply"));
    return { kind: "failed" };
  } finally {
    acquired.prepared.release?.();
  }
}

function answerApply(
  queryClient: QueryClient,
  claim: DraftClaim,
  result: DraftItemApplyResult,
  threadId: string | null,
): DraftCommandOutcome {
  const { draft } = claim;
  switch (result.status) {
    case "applied":
    case "already_live": {
      const overrode = result.status === "applied" ? result.overrode : [];
      const itemClosed = result.status === "applied" && result.itemClosed;
      noteOverrode(claim, overrode);
      releaseDraftCommand(claim);
      refresh(queryClient, draft, threadId);
      return { kind: "applied", overrode, itemClosed };
    }
    case "gone":
      releaseDraftCommand(claim);
      refresh(queryClient, draft, threadId);
      return { kind: "gone" };
    default:
      failDraftCommand(claim, { code: "apply-refused", serverCode: itemRefusalCode(result) });
      refresh(queryClient, draft, threadId);
      return { kind: "failed" };
  }
}

// ---- item Discard ----

/**
 * Close an item on the server (item Discard: a created, binary or live-deleted item). A review's own
 * Discard is a local editor edit and never calls this; lists and the Work page do.
 */
export async function discardDraftItem(
  queryClient: QueryClient,
  draft: DraftRef,
  threadId: string | null = null,
): Promise<DraftCommandOutcome> {
  const claim = beginDraftCommand(draft, "discard");
  if (!claim) return { kind: "blocked" };
  if (!canSend()) {
    failDraftCommand(claim, { code: "discard-offline" });
    return { kind: "blocked" };
  }
  try {
    const draftId = await draftIdOf(queryClient, draft);
    if (!draftId) {
      releaseDraftCommand(claim);
      refresh(queryClient, draft, threadId);
      return { kind: "gone" };
    }
    const body: Omit<Parameters<typeof postDiscardDraft>[3], "commandId"> = {
      draftId,
      itemKey: draft.itemKey,
    };
    const carried = await carry<DraftItemDiscardResult>(queryClient, draft, {
      kind: "discard-item",
      body,
      send: (request) =>
        postDiscardDraft(
          draft.projectId,
          draft.workId,
          draft.documentId,
          request as Parameters<typeof postDiscardDraft>[3],
        ),
      observe: (commandId) => observeDraftCommand(draft.projectId, draft.workId, commandId),
      live: () => claimIsLive(claim),
    });
    if (carried.kind === "revoked") return { kind: "blocked" };
    if (carried.kind === "blocked") {
      failDraftCommand(claim, { code: "apply-blocked" });
      return { kind: "failed" };
    }
    if (carried.kind === "error") {
      failDraftCommand(claim, draftFailureOf(carried.error, "discard"));
      return { kind: "failed" };
    }
    releaseDraftCommand(claim);
    refresh(queryClient, draft, threadId);
    return carried.result.status === "discarded" ? { kind: "discarded" } : { kind: "gone" };
  } catch (error) {
    failDraftCommand(claim, draftFailureOf(error, "discard"));
    return { kind: "failed" };
  }
}

// ---- the Work page: Apply all, Discard all ----

type WorkTarget = { itemKey: string; documentId: string };

/**
 * Work Files' Apply all and Discard all: one server command over the Work's draft (`apply_items` over the
 * listed items, or `discard_draft`). Each item the command acts on takes its own claim (it leaves every
 * surface at the click and locks its controls) and settles from the one answer. An item whose own command
 * is in flight is left to that command. Apply all sends each item as it stands when the server stages it
 * (staging is consent, Q1), so it carries no snapshots.
 */
export function runWorkWideCommand(
  queryClient: QueryClient,
  scope: { projectId: string; workId: string },
  mode: "apply" | "discard",
  drafts: readonly WorkTarget[],
  threadId: string | null,
  onSent?: (claimed: readonly WorkTarget[]) => void,
): Promise<DraftCommandOutcome[]> {
  const blocked: DraftCommandOutcome = { kind: "blocked" };
  const rows =
    queryClient.getQueryData<ThreadDraftListItem[]>(
      projectQueryKeys.workDrafts(scope.projectId, scope.workId),
    ) ?? [];
  const draftId = workDraftId(rows);
  const targets = drafts.flatMap((draft) => {
    const row = rows.find((item) => item.itemKey === draft.itemKey);
    return row ? [{ draft: { ...scope, ...draft }, row }] : [];
  });
  if (!draftId || targets.length === 0) return Promise.resolve(drafts.map(() => blocked));
  if (!canSend()) {
    const failure: DraftCommandFailure = { code: `${mode}-offline` };
    for (const { draft } of targets) {
      const claim = beginDraftCommand(draft, mode);
      if (claim) failDraftCommand(claim, failure);
    }
    return Promise.resolve(drafts.map(() => ({ kind: "failed" })));
  }
  const claims = targets.flatMap(({ draft, row }) => {
    const claim = beginDraftCommand(draft, mode);
    return claim ? [{ claim, row }] : [];
  });
  if (claims.length === 0) return Promise.resolve(drafts.map(() => blocked));
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
  scope: { projectId: string; workId: string },
  mode: "apply" | "discard",
  draftId: string,
  claims: readonly { claim: DraftClaim; row: ThreadDraftListItem }[],
  threadId: string | null,
): Promise<Map<string, DraftCommandOutcome>> {
  const outcomes = new Map<string, DraftCommandOutcome>();
  const first = claims[0].claim.draft;
  const live = () => claims.some(({ claim }) => claimIsLive(claim));
  const settle = (
    each: (claim: DraftClaim, row: ThreadDraftListItem) => DraftCommandOutcome | null,
  ) => {
    for (const { claim, row } of claims) {
      if (!claimIsLive(claim)) continue;
      const outcome = each(claim, row);
      if (outcome) outcomes.set(row.itemKey, outcome);
    }
  };
  const fail = (failure: DraftCommandFailure) =>
    settle((claim) => {
      failDraftCommand(claim, failure);
      return { kind: "failed" };
    });
  const observe = (commandId: string) =>
    observeDraftCommand(scope.projectId, scope.workId, commandId);
  try {
    if (mode === "apply")
      void queryClient.cancelQueries({
        queryKey: projectQueryKeys.workDrafts(scope.projectId, scope.workId),
      });
    const carried =
      mode === "apply"
        ? await carry<DraftApplyAllResult>(queryClient, first, {
            kind: "work-apply",
            body: {
              draftId,
              items: claims.map(({ row }) => ({
                itemKey: row.itemKey,
                locationToken: row.tokens.locationToken,
              })),
            } satisfies Omit<DraftApplyAllBody, "commandId">,
            send: (request) =>
              applyAllDrafts(scope.projectId, scope.workId, request as DraftApplyAllBody),
            observe,
            live,
          })
        : await carry<DraftDiscardAllResponse>(queryClient, first, {
            kind: "work-discard",
            body: { draftId },
            send: (request) =>
              discardAllDrafts(
                scope.projectId,
                scope.workId,
                request as Parameters<typeof discardAllDrafts>[2],
              ),
            observe,
            live,
          });
    if (carried.kind === "revoked") return outcomes;
    if (carried.kind === "blocked") {
      refresh(queryClient, scope, threadId);
      fail({ code: "apply-blocked" });
      return outcomes;
    }
    if (carried.kind === "error") {
      fail(draftFailureOf(carried.error, mode));
      return outcomes;
    }
    const result = carried.result;
    refresh(queryClient, scope, threadId);
    if (result.status === "gone") {
      settle(() => ({ kind: "gone" }));
    } else if (result.status === "discarded") {
      settle(() => ({ kind: "discarded" }));
    } else if (result.status === "stale") {
      const stale = new Set<string>(result.staleItemKeys);
      settle((claim, row) => {
        if (!stale.has(row.itemKey)) return { kind: "blocked" };
        failDraftCommand(claim, { code: "apply-refused", serverCode: "stale" });
        return { kind: "failed" };
      });
    } else {
      const byKey = new Map(result.items.map((item) => [item.itemKey, item]));
      settle((claim, row) => {
        const item = byKey.get(row.itemKey);
        if (item?.status === "applied" || item?.status === "already_live") {
          const overrode = item.status === "applied" ? item.overrode : [];
          noteOverrode(claim, overrode);
          return {
            kind: "applied",
            overrode,
            itemClosed: item.status === "applied" && item.itemClosed,
          };
        }
        failDraftCommand(claim, {
          code: "apply-refused",
          serverCode: item ? refusalCode(item) : "stale",
        });
        return { kind: "failed" };
      });
      void queryClient
        .invalidateQueries({
          predicate: (query) => isProjectContextCatalogKey(query.queryKey, scope.projectId),
        })
        .catch(() => undefined);
    }
    return outcomes;
  } finally {
    for (const { claim } of claims) releaseDraftCommand(claim);
  }
}
