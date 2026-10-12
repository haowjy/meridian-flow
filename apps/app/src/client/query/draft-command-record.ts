/** Shared draft commands, selection outcomes, batch leases and distinct list/preview read fences. */
import { type DraftPreviewResponse, operationKey } from "@meridian/contracts/drafts";
import { useMemo } from "react";
import { create } from "zustand";
import type { DraftCommandOutcome } from "./draft-command-executor";
import type { ActivePreview, DraftIntentKeys } from "./draft-projection";

type DraftScope = { projectId: string; workId: string };
export type DraftRef = DraftScope & { documentId: string; draftId: string };
type ListedDraft = { documentId: string; draftId: string; draftGeneration?: number };

/**
 * What a held failure is, never its wording. `-offline`: the request never got
 * there (no network, or lost). `-refused`: the server answered with a typed
 * reason, carried beside the code. `-server-error`: it answered with an error
 * that gave no reason. Wording is the render layer's (`ReviewMessageText`).
 */
export type DraftCommandFailureCode =
  | "apply-offline"
  | "apply-refused"
  | "apply-server-error"
  | "apply-unknown"
  | "discard-offline"
  | "discard-refused"
  | "discard-server-error"
  | "review-failed";

/**
 * What a typed server refusal said, as the server sent it: its error code and
 * its own text. Kept so the words are chosen when the failure is shown.
 */
export type ServerRefusal = { serverCode: string; serverReason?: string };

/** A held failure: its code and, for a refusal, what the server said. */
export type DraftCommandFailure = { code: DraftCommandFailureCode } & Partial<ServerRefusal>;

export type ChangeCommandMode = "apply" | "discard";

/**
 * Changes under review that one command acts on: whole server closure classes
 * and every operation they hold. One change is a selection of one class; the
 * chat strip's Apply is a selection of several.
 */
export type ChangeSelection = {
  classIds: readonly string[];
  /** The rows to send: names in the generation the selection was made in, valid for admission only. */
  operationIds: readonly string[];
  /**
   * What the changes are across draft generations (`operationKey`). A Discard
   * re-forks the draft, so its survivors get new row and operation ids; a click
   * not yet sent, a held failure and the focus find their change again by these.
   */
  keys?: readonly string[];
};

/** A selection's identity: its keys, or the rows themselves when it was made without any. */
export function selectionKeys(selection: ChangeSelection): readonly string[] {
  return selection.keys ?? selection.operationIds.map((id) => `row:${id}`);
}

/**
 * What the server's closing answer left to say about the draft, read when it
 * landed: the draft leaves the Work's list once the answer's reads do.
 */
export type ClosedDraft = { documentName: string | null };

/** Selection identity and addressed settlement, shared with every observing review. */
export type PendingChangeCommand = ChangeSelection & {
  target: "selection";
  mode: ChangeCommandMode;
  draftGeneration: number;
  completesDraft?: true;
  draftClosed?: ClosedDraft;
  outcome?: "applied" | "discarded" | "change-gone";
};

export type PendingDraftCommand =
  | PendingChangeCommand
  | {
      target: "all";
      mode: ChangeCommandMode;
      draftGeneration: number | undefined;
      completesDraft?: true;
      draftClosed?: ClosedDraft;
    };

type DraftClaimRecord =
  | { phase: "pending"; command: PendingDraftCommand; token: symbol }
  | { phase: "failed"; failure: DraftCommandFailure; at: number }
  /** `draftGeneration` is the generation the command acted on: a newer proposal is not what it confirmed. */
  | { phase: "confirmed"; at: number; draftGeneration?: number };

type DraftCommandRecord = {
  claim?: DraftClaimRecord;
  outcomes: Readonly<Record<string, ChangeCommandRecord>>;
};
export type DraftCommandRecords = Readonly<Record<string, DraftCommandRecord>>;

const useDraftCommandStore = create<{
  records: DraftCommandRecords;
  queued: QueuedSelections;
  batches: Readonly<Record<string, symbol>>;
  /** The loop sending each draft's queued clicks; a reset retires it with the queue. */
  drains: Readonly<Record<string, symbol>>;
  clock: number;
}>(() => ({
  records: {},
  queued: {},
  batches: {},
  drains: {},
  clock: 0,
}));

let boundAccountId: string | null = null;
/** Moves on every account change: work admitted in an earlier one can no longer publish. */
let accountEpoch = 0;

/**
 * An admitted command's capability over its own claim. Everything the command
 * publishes after an await (answers, confirmations, failures, release) goes
 * through it, and lands only while this claim is still the draft's pending one
 * in the account epoch it was admitted in.
 */
export type DraftClaim = {
  readonly draft: DraftRef;
  readonly epoch: number;
  readonly token: symbol;
};

export function claimIsLive(claim: DraftClaim): boolean {
  const record = recordFor(claim.draft);
  return (
    claim.epoch === accountEpoch && record?.phase === "pending" && record.token === claim.token
  );
}

/** Work admitted before an account change is dead; a batch or queue checks this between sends. */
export function accountEpochIs(epoch: number): boolean {
  return epoch === accountEpoch;
}

export function currentAccountEpoch(): number {
  return accountEpoch;
}

/** A claim, or a bare draft for publication that is not behind an await (and so cannot outlive anything). */
type Publisher = DraftClaim | DraftRef;
function mayPublish(by: Publisher): boolean {
  return !("token" in by) || claimIsLive(by);
}
function draftOf(by: Publisher): DraftRef {
  return "token" in by ? by.draft : by;
}
/** List and preview reads retain only their own pre-confirmation masks. */
const readsInFlight = new Set<{ fence: number; kind: "list" | "preview" }>();

function scopePrefix({ projectId, workId }: DraftScope): string {
  return `${projectId}\u0000${workId}\u0000`;
}

export function draftCommandKey(draft: DraftRef): string {
  return `${scopePrefix(draft)}${draft.documentId}\u0000${draft.draftId}`;
}

/** Mutations and retention share one update path; empty draft records never survive. */
function updateDraftRecord(
  key: string,
  update: (record: DraftCommandRecord, at: number) => DraftCommandRecord,
  advance = false,
): void {
  useDraftCommandStore.setState((state) => {
    const prior = state.records[key] ?? { outcomes: {} };
    const clock = state.clock + Number(advance);
    const next = update(prior, clock);
    if (next === prior) return state;
    const { [key]: _prior, ...rest } = state.records;
    return {
      clock,
      records: next.claim || Object.keys(next.outcomes).length ? { ...rest, [key]: next } : rest,
    };
  });
}

function setRecord(
  draft: DraftRef,
  record: (clock: number) => DraftClaimRecord | null,
  advance = false,
): void {
  updateDraftRecord(
    draftCommandKey(draft),
    (prior, clock) => {
      const claim = record(clock);
      return { ...(claim ? { claim } : {}), outcomes: prior.outcomes };
    },
    advance,
  );
}

function recordFor(draft: DraftRef): DraftClaimRecord | undefined {
  return useDraftCommandStore.getState().records[draftCommandKey(draft)]?.claim;
}

/**
 * Claim the draft for one command: a whole-draft Apply or Discard, or, with
 * `command`, a selection's. One command at a time per draft, whichever
 * surface or session sends it; false when one is already in flight.
 */
export function beginDraftCommand(
  draft: DraftRef,
  command: PendingDraftCommand,
): DraftClaim | null {
  if (recordFor(draft)?.phase === "pending") return null;
  const token = Symbol(draftCommandKey(draft));
  setRecord(draft, () => ({ phase: "pending", command, token }));
  return { draft, epoch: accountEpoch, token };
}

/**
 * The server answered the selection command in flight on this draft and
 * closed the draft. Reviews showing it settle on this before the draft list is
 * re-read (`subscribeDraftCommandRecords`).
 */
export function answerDraftCommandClosed(by: DraftClaim | DraftRef, closed: ClosedDraft): void {
  const draft = draftOf(by);
  const record = recordFor(draft);
  if (
    !mayPublish(by) ||
    record?.phase !== "pending" ||
    !record.command ||
    (record.command.target === "all" && !record.command.completesDraft)
  )
    return;
  const change = { ...record.command, draftClosed: closed };
  setRecord(draft, () => ({ phase: "pending", command: change, token: record.token }));
}

/** Publish an addressed selection result before caches refresh or the claim is released. */
export function answerDraftSelection(
  by: DraftClaim | DraftRef,
  outcome: PendingChangeCommand["outcome"],
): void {
  const draft = draftOf(by);
  const record = recordFor(draft);
  const command = pendingChangeCommand(currentDraftCommandRecords(), draft);
  if (command && record?.phase === "pending" && mayPublish(by))
    setRecord(draft, () => ({
      phase: "pending",
      command: { ...command, outcome },
      token: record.token,
    }));
}

/**
 * Release a claim that ended without a confirmation or a held failure. The
 * server's closing answer ends with the claim: the id it closed is reused for
 * the next proposal, so nothing outlives the claim to be mistaken for it.
 */
export function releaseDraftCommand(by: DraftClaim | DraftRef): void {
  const draft = draftOf(by);
  if (recordFor(draft)?.phase === "pending" && mayPublish(by)) setRecord(draft, () => null);
}

export function failDraftCommand(by: DraftClaim | DraftRef, failure: DraftCommandFailure): void {
  if (mayPublish(by)) setRecord(draftOf(by), (at) => ({ phase: "failed", failure, at }), true);
}

/** Opening Review failed; never displaces an Apply or Discard in flight on the draft. */
export function failDraftReviewLaunch(draft: DraftRef): void {
  if (recordFor(draft)?.phase !== "pending") failDraftCommand(draft, { code: "review-failed" });
}

/** Drop a held failure (dismissing it); never touches a claim. */
export function clearDraftCommandFailure(draft: DraftRef): void {
  if (recordFor(draft)?.phase === "failed") setRecord(draft, () => null);
}

/**
 * Opening Review is a new attempt: it retires the message of the last attempt
 * to open it. A refused Apply or Discard is not that message, and stays: the
 * writer may be taken to the draft that refused precisely to be told so.
 */
export function clearDraftReviewLaunchFailure(draft: DraftRef): void {
  const record = recordFor(draft);
  if (record?.phase === "failed" && record.failure.code === "review-failed")
    setRecord(draft, () => null);
}

export function confirmDraftCommand(by: DraftClaim | DraftRef): void {
  if (!mayPublish(by)) return;
  const draft = draftOf(by);
  const prior = recordFor(draft);
  const draftGeneration = prior?.phase === "pending" ? prior.command.draftGeneration : undefined;
  setRecord(
    draft,
    (at) => ({
      phase: "confirmed",
      at,
      ...(draftGeneration === undefined ? {} : { draftGeneration }),
    }),
    true,
  );
  retireConfirmations();
}

/** List confirmations retire after older reads; selection intents outlive retained observations. */
function retireConfirmations(): void {
  const oldest = (kind: "list" | "preview") =>
    Math.min(
      ...Array.from(readsInFlight)
        .filter((read) => read.kind === kind)
        .map((read) => read.fence),
    );
  const listFence = oldest("list");
  useDraftCommandStore.setState((state) => ({
    records: Object.fromEntries(
      Object.entries(state.records).flatMap(([key, record]) => {
        const claim =
          record.claim?.phase === "confirmed" && record.claim.at <= listFence
            ? undefined
            : record.claim;
        const outcomes = record.outcomes;
        if (
          claim === record.claim &&
          Object.keys(outcomes).length === Object.keys(record.outcomes).length
        )
          return [[key, record]];
        return claim || Object.keys(outcomes).length
          ? [[key, { ...(claim ? { claim } : {}), outcomes }]]
          : [];
      }),
    ),
  }));
}

/**
 * Run one Work draft-list read. Drafts confirmed after the read started are
 * removed from its result, and failures held for drafts the read no longer
 * lists are dropped.
 */
export async function readDraftsAfterCommands<T extends ListedDraft>(
  scope: DraftScope,
  read: () => Promise<T[]>,
): Promise<T[]> {
  const inFlight = { fence: useDraftCommandStore.getState().clock, kind: "list" as const };
  readsInFlight.add(inFlight);
  try {
    const listed = await read();
    const { records } = useDraftCommandStore.getState();
    const drafts = listed.filter((draft) => {
      const record = records[draftCommandKey({ ...scope, ...draft })]?.claim;
      if (record?.phase !== "confirmed" || record.at <= inFlight.fence) return true;
      // A newer proposal under the same id is not what the command confirmed.
      return (
        record.draftGeneration !== undefined &&
        draft.draftGeneration !== undefined &&
        draft.draftGeneration > record.draftGeneration
      );
    });
    const stillListed = new Set(drafts.map((draft) => draftCommandKey({ ...scope, ...draft })));
    const prefix = scopePrefix(scope);
    const gone = Object.entries(records).filter(
      ([key, record]) =>
        record.claim?.phase === "failed" &&
        record.claim.at <= inFlight.fence &&
        key.startsWith(prefix) &&
        !stillListed.has(key),
    );
    for (const [key] of gone) {
      const [documentId = "", draftId = ""] = key.slice(prefix.length).split("\u0000");
      setRecord({ ...scope, documentId, draftId }, () => null);
    }
    return drafts;
  } finally {
    readsInFlight.delete(inFlight);
    retireConfirmations();
  }
}

/** Every held record; look rows up with `draftCommandKey`. */
export function useDraftCommandRecords(): DraftCommandRecords {
  return useDraftCommandStore().records;
}

export function draftCommandFailure(
  records: DraftCommandRecords,
  draft: DraftRef,
): DraftCommandFailure | null {
  const record = records[draftCommandKey(draft)]?.claim;
  return record?.phase === "failed" ? record.failure : null;
}

/** The selection command in flight on this draft, if the claim is one. */
export function pendingDraftCommand(
  records: DraftCommandRecords,
  draft: DraftRef,
): PendingDraftCommand | null {
  const record = records[draftCommandKey(draft)]?.claim;
  return record?.phase === "pending" ? (record.command ?? null) : null;
}

export function pendingChangeCommand(
  records: DraftCommandRecords,
  draft: DraftRef,
): PendingChangeCommand | null {
  const command = pendingDraftCommand(records, draft);
  return command?.target === "selection" ? command : null;
}

/** The drafts of this project's Work whose record differs between two snapshots. */
export function changedDrafts(
  records: DraftCommandRecords,
  previous: DraftCommandRecords,
  scope: DraftScope,
): DraftRef[] {
  const prefix = scopePrefix(scope);
  return [...new Set([...Object.keys(records), ...Object.keys(previous)])]
    .filter((key) => key.startsWith(prefix) && records[key] !== previous[key])
    .map((key) => {
      const [documentId = "", draftId = ""] = key.slice(prefix.length).split("\u0000");
      return { ...scope, documentId, draftId };
    });
}

/** A command is in flight on any draft of this project's Work. */
export function draftCommandPendingIn(records: DraftCommandRecords, scope: DraftScope): boolean {
  const prefix = scopePrefix(scope);
  return (
    Boolean(useDraftCommandStore.getState().batches[scopePrefix(scope)]) ||
    Object.entries(records).some(
      ([key, record]) => record.claim?.phase === "pending" && key.startsWith(prefix),
    )
  );
}

/**
 * A whole-draft command or a batch holds this Work: per-change commands wait
 * for it. A per-change command in flight never does; further ones queue
 * behind it (`runDraftSelection`).
 */
export function wholeDraftCommandPendingIn(
  records: DraftCommandRecords,
  scope: DraftScope,
): boolean {
  const prefix = scopePrefix(scope);
  return (
    Boolean(useDraftCommandStore.getState().batches[prefix]) ||
    Object.entries(records).some(
      ([key, record]) =>
        key.startsWith(prefix) &&
        record.claim?.phase === "pending" &&
        record.claim.command.target === "all",
    )
  );
}

/** Empty the store when a different account signs in; a no-op for the same one. */
export function bindDraftCommandAccount(accountId: string): void {
  if (boundAccountId === accountId) return;
  boundAccountId = accountId;
  resetDraftCommandRecords();
}

/** Clears what is shown and revokes every claim: an answer that arrives later has nothing to publish into. */
export function resetDraftCommandRecords(): void {
  accountEpoch += 1;
  const unsent = Object.values(useDraftCommandStore.getState().queued);
  useDraftCommandStore.setState({ records: {}, queued: {}, batches: {}, drains: {} });
  // A click that never got its turn is answered, not left waiting on a queue that is gone.
  for (const entry of unsent) entry.settle?.({ kind: "blocked" });
}

/** A Work-wide batch lease lives beside its addressed commands, including request gaps. */
export function beginDraftBatch(scope: DraftScope): (() => void) | null {
  const key = scopePrefix(scope);
  if (useDraftCommandStore.getState().batches[key]) return null;
  const token = Symbol(key);
  useDraftCommandStore.setState((state) => ({ batches: { ...state.batches, [key]: token } }));
  return () => {
    if (useDraftCommandStore.getState().batches[key] !== token) return;
    useDraftCommandStore.setState((state) => {
      const { [key]: _done, ...batches } = state.batches;
      return { batches };
    });
  };
}

/**
 * Be told, synchronously, of every change to the records and what they were.
 * For state that must follow a command's claim and answer in the same tick
 * (a review's completion), which a render cannot promise.
 */
export function subscribeDraftCommandRecords(
  listener: (records: DraftCommandRecords, previous: DraftCommandRecords) => void,
): () => void {
  return useDraftCommandStore.subscribe((state, previous) => {
    if (state.records !== previous.records) listener(state.records, previous.records);
  });
}

/** The records right now, for code that is not a render (commands, tests). */
export function currentDraftCommandRecords(): DraftCommandRecords {
  return useDraftCommandStore.getState().records;
}

/** Why a change command did not land; the copy lives in the render layer. */
export type ChangeFailureCode =
  /** The request never got an answer: the browser is offline or the connection dropped. */
  | "offline"
  /** The server refused with a typed reason (`serverCode` and `serverReason` on the record, as the server sent them). */
  | "refused"
  /** The server answered with an error that gave no reason. */
  | "server-error"
  /** An Apply got no answer: it may or may not have landed. Never read as a refusal. */
  | "unknown"
  /** The change was updated under the writer; the preview is re-read. */
  | "stale"
  /** The change is no longer in the draft. */
  | "gone";

type ChangeCommandRecord = ChangeSelection &
  (
    | ({
        phase: "failed";
        mode: ChangeCommandMode;
        code: ChangeFailureCode;
        at: number;
      } & Partial<ServerRefusal>)
    | { phase: "confirmed"; mode: ChangeCommandMode; at: number }
  );

export type ChangeCommandState =
  | { phase: "pending"; mode: ChangeCommandMode }
  | ({
      phase: "failed";
      mode: ChangeCommandMode;
      code: ChangeFailureCode;
    } & Partial<ServerRefusal>);

/** Everything that says what is happening to a draft's changes: held outcomes and the draft's own claim. */
export type ChangeCommandRecords = {
  queued: QueuedSelections;
  drafts: DraftCommandRecords;
};

/**
 * A selection that has not had its turn: hidden, not claimed. One with `settle`
 * is a click the writer made (sent in order by `runDraftSelection`, which owns
 * its drain and its caller's promise here); the others belong to a batch, which
 * sends them itself.
 */
type QueuedSelection = ChangeSelection & {
  prefix: string;
  mode: ChangeCommandMode;
  /** The account epoch this click was admitted in. */
  epoch: number;
  /** Set for a click `runDraftSelection` sends; settles the caller's promise. */
  settle?: (outcome: DraftCommandOutcome) => void;
};
type QueuedSelections = Readonly<Record<number, QueuedSelection>>;

let nextQueued = 0;

function recordKey(selection: ChangeSelection): string {
  return [...selection.classIds].sort().join("\u0001");
}

function setChangeRecord(
  draft: DraftRef,
  selection: ChangeSelection,
  outcome: (clock: number) => ChangeCommandRecord,
): void {
  updateDraftRecord(
    draftCommandKey(draft),
    (prior, clock) => {
      return {
        ...prior,
        outcomes: { ...prior.outcomes, [recordKey(selection)]: outcome(clock) },
      };
    },
    true,
  );
}

/** Claim the draft for one command on this selection; false when any command is in flight on the draft. */
export function beginChangeCommand(
  draft: DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
  draftGeneration: number,
  completesDraft = false,
): DraftClaim | null {
  const claim = beginDraftCommand(draft, {
    target: "selection",
    classIds: selection.classIds,
    operationIds: selection.operationIds,
    ...(selection.keys ? { keys: selection.keys } : {}),
    mode,
    draftGeneration,
    ...(completesDraft ? { completesDraft: true as const } : {}),
  });
  // The claim is the next action on these changes: a failure they held is stale now.
  if (claim) clearChangeFailure(draft, selection);
  return claim;
}

/** Queued selections hide immediately; each retires when its claim starts or the batch ends. */
export function queueChangeSelection(
  draft: DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
  settle?: (outcome: DraftCommandOutcome) => void,
): QueuedChange {
  const id = nextQueued++;
  const entry: QueuedSelection = {
    ...selection,
    prefix: draftCommandKey(draft),
    mode,
    epoch: accountEpoch,
    ...(settle ? { settle } : {}),
  };
  useDraftCommandStore.setState((state) => ({ queued: { ...state.queued, [id]: entry } }));
  return { id, epoch: accountEpoch, retire: () => retireQueuedSelection(id) };
}

/** A queued selection's capability: live only while it is still queued in the account epoch it was made in. */
export type QueuedChange = { id: number; epoch: number; retire: () => void };

export function retireQueuedSelection(id: number): void {
  if (!(id in useDraftCommandStore.getState().queued)) return;
  useDraftCommandStore.setState((state) => {
    const { [id]: _retired, ...rest } = state.queued;
    return { queued: rest };
  });
}

export function queuedChangeIsLive(change: Pick<QueuedChange, "id" | "epoch">): boolean {
  return change.epoch === accountEpoch && change.id in useDraftCommandStore.getState().queued;
}

/** Become the one loop sending this draft's queued clicks; null while another is. */
export function beginIntentDrain(draft: DraftRef): symbol | null {
  const key = draftCommandKey(draft);
  if (useDraftCommandStore.getState().drains[key]) return null;
  const token = Symbol(key);
  useDraftCommandStore.setState((state) => ({ drains: { ...state.drains, [key]: token } }));
  return token;
}

export function intentDrainCurrent(draft: DraftRef, token: symbol): boolean {
  return useDraftCommandStore.getState().drains[draftCommandKey(draft)] === token;
}

export function endIntentDrain(draft: DraftRef, token: symbol): void {
  if (!intentDrainCurrent(draft, token)) return;
  useDraftCommandStore.setState((state) => {
    const { [draftCommandKey(draft)]: _done, ...drains } = state.drains;
    return { drains };
  });
}

/** The writer's oldest click on this draft that has not been sent yet. */
export function nextQueuedClick(draft: DraftRef): {
  change: QueuedChange;
  selection: ChangeSelection;
  mode: ChangeCommandMode;
  settle: (outcome: DraftCommandOutcome) => void;
} | null {
  const prefix = draftCommandKey(draft);
  for (const [id, entry] of Object.entries(useDraftCommandStore.getState().queued)) {
    if (entry.settle && entry.prefix === prefix)
      return {
        change: {
          id: Number(id),
          epoch: entry.epoch,
          retire: () => retireQueuedSelection(Number(id)),
        },
        selection: {
          classIds: entry.classIds,
          operationIds: entry.operationIds,
          ...(entry.keys ? { keys: entry.keys } : {}),
        },
        mode: entry.mode,
        settle: entry.settle,
      };
  }
  return null;
}

export function failChangeCommand(
  by: DraftClaim | DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
  code: ChangeFailureCode,
  refusal?: ServerRefusal,
): void {
  if (!mayPublish(by)) return;
  setChangeRecord(draftOf(by), selection, (at) => ({
    phase: "failed",
    mode,
    code,
    ...(refusal ? { serverCode: refusal.serverCode } : {}),
    ...(refusal?.serverReason ? { serverReason: refusal.serverReason } : {}),
    at,
    classIds: selection.classIds,
    operationIds: selection.operationIds,
    ...(selection.keys ? { keys: selection.keys } : {}),
  }));
}

export function confirmChangeCommand(
  by: DraftClaim | DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
): void {
  if (!mayPublish(by)) return;
  setChangeRecord(draftOf(by), selection, (at) => ({
    phase: "confirmed",
    mode,
    at,
    classIds: selection.classIds,
    operationIds: selection.operationIds,
    ...(selection.keys ? { keys: selection.keys } : {}),
  }));
  retireConfirmations();
}

type FailedRecord = Extract<ChangeCommandRecord, { phase: "failed" }>;

/** The two selections name a change in common. */
function overlaps(left: ChangeSelection, right: ChangeSelection): boolean {
  const keys = new Set(selectionKeys(right));
  return selectionKeys(left).some((key) => keys.has(key));
}

/** Regrouped classes keep failures through operation overlap; unrelated changes do not inherit them. */
function failuresOfSelection(
  records: DraftCommandRecords,
  draft: DraftRef,
  selection: ChangeSelection,
): { key: string; record: FailedRecord }[] {
  return Object.entries(records[draftCommandKey(draft)]?.outcomes ?? {}).flatMap(([key, record]) =>
    record.phase === "failed" && overlaps(record, selection) ? [{ key, record }] : [],
  );
}

/** Retire only failures that overlap the writer's next action. */
export function clearChangeFailure(draft: DraftRef, selection: ChangeSelection): void {
  updateDraftRecord(draftCommandKey(draft), (prior) => {
    const outcomes = Object.fromEntries(
      Object.entries(prior.outcomes).filter(
        ([, record]) => record.phase !== "failed" || !overlaps(record, selection),
      ),
    );
    return Object.keys(outcomes).length === Object.keys(prior.outcomes).length
      ? prior
      : { ...prior, outcomes };
  });
}

/**
 * Read immutable preview evidence and retire failures it no longer describes.
 * Confirmed keys stay as account-scoped intents: older cached or held observations
 * still project them, without mutating the evidence or resurrecting settled changes.
 */
export async function readPreviewAfterChangeCommands(
  draft: DraftRef,
  read: () => Promise<DraftPreviewResponse>,
): Promise<DraftPreviewResponse> {
  const inFlight = { fence: useDraftCommandStore.getState().clock, kind: "preview" as const };
  readsInFlight.add(inFlight);
  try {
    const preview = await read();
    const prefix = draftCommandKey(draft);
    // A failure held for a change the preview no longer lists describes nothing.
    if (preview.status === "active") dropFailuresWithoutOperations(prefix, preview, inFlight.fence);
    return preview;
  } finally {
    readsInFlight.delete(inFlight);
    retireConfirmations();
  }
}

function dropFailuresWithoutOperations(key: string, preview: ActivePreview, fence: number): void {
  const listed = new Set(preview.operations.map(operationKey));
  updateDraftRecord(key, (prior) => {
    const outcomes = Object.fromEntries(
      Object.entries(prior.outcomes).filter(
        ([, record]) =>
          record.phase !== "failed" ||
          record.at > fence ||
          selectionKeys(record).some((key) => listed.has(key)),
      ),
    );
    return Object.keys(outcomes).length === Object.keys(prior.outcomes).length
      ? prior
      : { ...prior, outcomes };
  });
}

/** Every held record and claim; look changes up with `changeCommandState`. */
export function useChangeCommandRecords(): ChangeCommandRecords {
  const drafts = useDraftCommandRecords();
  const queued = useDraftCommandStore((state) => state.queued);
  return useMemo(() => ({ drafts, queued }), [drafts, queued]);
}

export function currentChangeCommandRecords(): ChangeCommandRecords {
  const { records: drafts, queued } = useDraftCommandStore.getState();
  return { drafts, queued };
}

/**
 * What the writer has done to this draft's changes, by key: those queued,
 * pending or confirmed are `hidden`, and of them the Discards are `restoring`
 * (the editor draws their original text until the next generation paints).
 */
export function intentKeys(records: ChangeCommandRecords, draft: DraftRef): DraftIntentKeys {
  const key = draftCommandKey(draft);
  const hidden = new Set<string>();
  const restoring = new Set<string>();
  const add = (selection: ChangeSelection, mode: ChangeCommandMode) => {
    for (const k of selectionKeys(selection)) {
      hidden.add(k);
      if (mode === "discard") restoring.add(k);
    }
  };
  for (const record of Object.values(records.drafts[key]?.outcomes ?? {}))
    if (record.phase !== "failed") add(record, record.mode);
  for (const queued of Object.values(records.queued))
    if (queued.prefix === key) add(queued, queued.mode);
  const pending = pendingChangeCommand(records.drafts, draft);
  if (pending) add(pending, pending.mode);
  return { hidden, restoring };
}

/**
 * What the command records say of a selection: its claim, else its latest
 * failure (`failuresOfSelection`). A change asks with its own class; a file
 * (strip, Work row) asks with the selection it sent.
 */
export function changeCommandState(
  records: ChangeCommandRecords,
  draft: DraftRef,
  selection: ChangeSelection,
): ChangeCommandState | null {
  const pending = pendingChangeCommand(records.drafts, draft);
  if (pending && overlaps(pending, selection)) {
    return { phase: "pending", mode: pending.mode };
  }
  // Several can apply after regrouping; the writer's latest action is the one that counts.
  const latest = failuresOfSelection(records.drafts, draft, selection).reduce<FailedRecord | null>(
    (newest, { record }) => (newest && newest.at > record.at ? newest : record),
    null,
  );
  if (!latest) return null;
  return {
    phase: "failed",
    mode: latest.mode,
    code: latest.code,
    ...(latest.serverCode ? { serverCode: latest.serverCode } : {}),
    ...(latest.serverReason ? { serverReason: latest.serverReason } : {}),
  };
}
