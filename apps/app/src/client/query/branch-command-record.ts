/** Shared draft commands, selection outcomes, distinct list/preview read fences. */
import { type DraftPreviewResponse, operationKey } from "@meridian/contracts/branches";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { replaceEqualDeep } from "@tanstack/react-query";
import { useMemo } from "react";
import { create } from "zustand";
import type { BranchCommandOutcome } from "./branch-command-executor";
import type { ActivePreview, DraftIntentKeys } from "./draft-projection";

type BranchScope = { projectId: string; workId: string };
export type DraftRef = BranchScope & { documentId: string; itemKey: string };
type ListedDraft = { documentId: string; itemKey: string; draftGeneration?: number | null };

/**
 * What a held failure is, never its wording. `-offline`: the request never got
 * there (no network, or lost). `-refused`: the server answered with a typed
 * reason, carried beside the code. `-server-error`: it answered with an error
 * that gave no reason. Wording is the render layer's (`ReviewMessageText`).
 */
export type BranchCommandFailureCode =
  | "apply-offline"
  | "apply-refused"
  | "apply-server-error"
  | "apply-unknown"
  | "apply-blocked"
  | "discard-unknown"
  | "discard-offline"
  | "discard-refused"
  | "discard-server-error"
  | "review-failed";

/**
 * What a typed server refusal said, as the server sent it: its error code and
 * its own text. Kept so the words are chosen when the failure is shown.
 */
export type ServerRefusal = {
  serverCode: string;
  serverReason?: string;
  /** A `deleted_live` hold's record: who removed the document Apply would have written. */
  removal?: DocumentRemovalRecord | null;
};

/** A held failure: its code and, for a refusal, what the server said. */
export type BranchCommandFailure = { code: BranchCommandFailureCode } & Partial<ServerRefusal>;

export type ChangeCommandMode = "apply" | "discard";

/**
 * Changes under review that one command acts on: whole server closure classes
 * and every operation they hold. One change is a selection of one class; the
 * chat strip's Apply is a selection of several.
 */
export type ChangeSelection = {
  classIds: readonly string[];
  /** Server evidence accepted at the click; queued resolution and retry never replace its meaning. */
  admissionTokens: readonly string[];
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
  itemClosed?: ClosedDraft;
  outcome?: "applied" | "discarded" | "change-gone";
};

export type PendingBranchCommand =
  | PendingChangeCommand
  | {
      target: "all";
      mode: ChangeCommandMode;
      draftGeneration: number | undefined;
      completesDraft?: true;
      itemClosed?: ClosedDraft;
    };

type DraftClaimRecord =
  | { phase: "pending"; command: PendingBranchCommand; token: symbol }
  | { phase: "failed"; failure: BranchCommandFailure; at: number };

type BranchCommandRecord = {
  claim?: DraftClaimRecord;
  /** Account-scoped Apply intent: retained cached observations still name this generation. */
  applied?: { draftGeneration: number | undefined; at: number };
  outcomes: Readonly<Record<string, ChangeCommandRecord>>;
};
export type BranchCommandRecords = Readonly<Record<string, BranchCommandRecord>>;

const useBranchCommandStore = create<{
  records: BranchCommandRecords;
  queued: QueuedSelections;
  /** The loop sending each draft's queued clicks; a reset retires it with the queue. */
  drains: Readonly<Record<string, symbol>>;
  /** Commands whose outcome stayed unknown: the writer's retry of the same body reuses the id. */
  unknown: Readonly<Record<string, { commandId: string; digest: string }>>;
  clock: number;
}>(() => ({
  records: {},
  queued: {},
  drains: {},
  unknown: {},
  clock: 0,
}));

/** Read-start clocks stay beside immutable observations, never inside server rows. */
const observations = new WeakMap<object, { fence: number; epoch: number }>();

/** Structural sharing preserves read identity across payload changes, never across commands. */
export function shareDraftObservation(prior: unknown, next: unknown): unknown {
  if (!prior) return next;
  const before = observations.get(prior as object);
  const after = observations.get(next as object);
  if (before?.fence !== after?.fence || before?.epoch !== after?.epoch) return next;
  const shared = replaceEqualDeep(prior, next);
  if (after) observations.set(shared as object, after);
  return shared;
}

let boundAccountId: string | null = null;
/** Moves on every account change: work admitted in an earlier one can no longer record. */
let accountEpoch = 0;

/**
 * An admitted command's capability over its own claim. Everything the command
 * records after an await (answers, confirmations, failures, release) goes
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

/** A claim, or a bare draft for a record write that is not behind an await (and so cannot outlive anything). */
type RecordWriter = DraftClaim | DraftRef;
function mayRecord(by: RecordWriter): boolean {
  return !("token" in by) || claimIsLive(by);
}
function draftOf(by: RecordWriter): DraftRef {
  return "token" in by ? by.draft : by;
}

function scopePrefix({ projectId, workId }: BranchScope): string {
  return `${projectId}\u0000${workId}\u0000`;
}

export function branchCommandKey(draft: DraftRef): string {
  return `${scopePrefix(draft)}${draft.documentId}\u0000${draft.itemKey}`;
}

/**
 * The id a command carries. A retry of a command whose outcome stayed unknown, with the same
 * body, reuses its id so the server answers the first attempt's outcome; any other body is a new
 * command. `digest` is the body without its id.
 */
export function commandIdFor(draft: DraftRef, kind: string, digest: string): string {
  const held = useBranchCommandStore.getState().unknown[`${branchCommandKey(draft)}\u0000${kind}`];
  return held?.digest === digest ? held.commandId : crypto.randomUUID();
}

/** Keep (`unknown`) or drop the id of the command that just ended. */
export function retainUnknownCommand(
  draft: DraftRef,
  kind: string,
  held: { commandId: string; digest: string } | null,
): void {
  const key = `${branchCommandKey(draft)}\u0000${kind}`;
  useBranchCommandStore.setState((state) => {
    if (!held && !(key in state.unknown)) return state;
    const { [key]: _prior, ...rest } = state.unknown;
    return { unknown: held ? { ...rest, [key]: held } : rest };
  });
}

/** Mutations and retention share one update path; empty draft records never survive. */
function updateDraftRecord(
  key: string,
  update: (record: BranchCommandRecord, at: number) => BranchCommandRecord,
  advance = false,
): void {
  useBranchCommandStore.setState((state) => {
    const prior = state.records[key] ?? { outcomes: {} };
    const clock = state.clock + Number(advance);
    const next = update(prior, clock);
    if (next === prior) return state;
    const { [key]: _prior, ...rest } = state.records;
    return {
      clock,
      records:
        next.claim || next.applied || Object.keys(next.outcomes).length
          ? { ...rest, [key]: next }
          : rest,
    };
  });
}

function setRecord(
  draft: DraftRef,
  record: (clock: number) => DraftClaimRecord | null,
  advance = false,
): void {
  updateDraftRecord(
    branchCommandKey(draft),
    (prior, clock) => {
      const claim = record(clock);
      const { claim: _claim, ...retained } = prior;
      return { ...retained, ...(claim ? { claim } : {}) };
    },
    advance,
  );
}

function recordFor(draft: DraftRef): DraftClaimRecord | undefined {
  return useBranchCommandStore.getState().records[branchCommandKey(draft)]?.claim;
}

/**
 * Claim the draft for one command: a whole-draft Apply or Discard, or, with
 * `command`, a selection's. One command at a time per draft, whichever
 * surface or session sends it; false when one is already in flight.
 */
export function beginBranchCommand(
  draft: DraftRef,
  command: PendingBranchCommand,
): DraftClaim | null {
  if (recordFor(draft)?.phase === "pending") return null;
  const token = Symbol(branchCommandKey(draft));
  setRecord(draft, () => ({ phase: "pending", command, token }));
  return { draft, epoch: accountEpoch, token };
}

/**
 * The server answered the selection command in flight on this draft and
 * closed the draft. Reviews showing it settle on this before the draft list is
 * re-read (`subscribeBranchCommandRecords`).
 */
export function answerBranchCommandClosed(by: DraftClaim | DraftRef, closed: ClosedDraft): void {
  const draft = draftOf(by);
  const record = recordFor(draft);
  if (
    !mayRecord(by) ||
    record?.phase !== "pending" ||
    !record.command ||
    (record.command.target === "all" && !record.command.completesDraft)
  )
    return;
  const change = { ...record.command, itemClosed: closed };
  setRecord(draft, () => ({
    phase: "pending",
    command: change,
    token: record.token,
  }));
}

/** Records an addressed selection result before caches refresh or the claim is released. */
export function answerDraftSelection(
  by: DraftClaim | DraftRef,
  outcome: PendingChangeCommand["outcome"],
): void {
  const draft = draftOf(by);
  const record = recordFor(draft);
  const command = pendingChangeCommand(currentBranchCommandRecords(), draft);
  if (command && record?.phase === "pending" && mayRecord(by))
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
export function releaseBranchCommand(by: DraftClaim | DraftRef): void {
  const draft = draftOf(by);
  if (recordFor(draft)?.phase === "pending" && mayRecord(by)) setRecord(draft, () => null);
}

export function failBranchCommand(by: DraftClaim | DraftRef, failure: BranchCommandFailure): void {
  if (mayRecord(by)) setRecord(draftOf(by), (at) => ({ phase: "failed", failure, at }), true);
}

/** Opening Review failed; never displaces an Apply or Discard in flight on the draft. */
export function failDraftReviewLaunch(draft: DraftRef): void {
  if (recordFor(draft)?.phase !== "pending") failBranchCommand(draft, { code: "review-failed" });
}

/** Drop a held failure (dismissing it); never touches a claim. */
export function clearBranchCommandFailure(draft: DraftRef): void {
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

export function confirmBranchCommand(by: DraftClaim | DraftRef): void {
  if (!mayRecord(by)) return;
  const draft = draftOf(by);
  const prior = recordFor(draft);
  if (
    prior?.phase !== "pending" ||
    prior.command.target !== "all" ||
    prior.command.mode !== "apply"
  )
    return;
  const draftGeneration = prior.command.draftGeneration;
  updateDraftRecord(
    branchCommandKey(draft),
    ({ claim: _claim, ...retained }, at) => ({
      ...retained,
      applied: {
        at,
        draftGeneration:
          retained.applied?.draftGeneration === undefined
            ? draftGeneration
            : Math.max(retained.applied.draftGeneration, draftGeneration ?? 0),
      },
    }),
    true,
  );
}

/**
 * Read immutable Work list evidence. Only failures predating this read may
 * retire on omission; settled Apply intents outlive cached/held observations.
 */
export async function readDraftsAfterCommands<T extends ListedDraft>(
  scope: BranchScope,
  read: () => Promise<T[]>,
): Promise<T[]> {
  const fence = useBranchCommandStore.getState().clock;
  const epoch = accountEpoch;
  const listed = await read();
  observations.set(listed, { fence, epoch });
  if (!accountEpochIs(epoch)) return listed;
  const { records } = useBranchCommandStore.getState();
  const stillListed = new Set(listed.map((draft) => branchCommandKey({ ...scope, ...draft })));
  const prefix = scopePrefix(scope);
  const gone = Object.entries(records).filter(
    ([key, record]) =>
      record.claim?.phase === "failed" &&
      !["apply-blocked", "apply-unknown", "discard-unknown"].includes(record.claim.failure.code) &&
      record.claim.at <= fence &&
      key.startsWith(prefix) &&
      !stillListed.has(key),
  );
  for (const [key] of gone) {
    const [documentId = "", itemKey = ""] = key.slice(prefix.length).split("\u0000");
    setRecord({ ...scope, documentId, itemKey }, () => null);
  }
  return listed;
}

/** The whole intent addressed to this observation; newer proposals never inherit it. */
export function wholeDraftDisposition(
  records: ChangeCommandRecords,
  draft: DraftRef,
  generation: number | undefined,
  observed?: object,
): ChangeCommandMode | null {
  const record = records.drafts[branchCommandKey(draft)];
  const addressed = (basis: number | undefined) =>
    basis === undefined
      ? generation === undefined
      : generation !== undefined && generation <= basis;
  const read = observed ? observations.get(observed) : undefined;
  if (
    record?.applied &&
    addressed(record.applied.draftGeneration) &&
    (!read || (read.epoch === accountEpoch && read.fence < record.applied.at))
  )
    return "apply";
  const claim = record?.claim;
  if (claim?.phase === "pending" && claim.command.target === "all")
    return addressed(claim.command.draftGeneration) ? claim.command.mode : null;
  const queued = Object.values(records.queued).find(
    (entry) => entry.prefix === branchCommandKey(draft) && entry.target === "all",
  );
  return queued?.mode ?? null;
}

/** Every held record; look rows up with `branchCommandKey`. */
export function useBranchCommandRecords(): BranchCommandRecords {
  return useBranchCommandStore().records;
}

export function branchCommandFailure(
  records: BranchCommandRecords,
  draft: DraftRef,
): BranchCommandFailure | null {
  const record = records[branchCommandKey(draft)]?.claim;
  return record?.phase === "failed" ? record.failure : null;
}

/** The selection command in flight on this draft, if the claim is one. */
export function pendingBranchCommand(
  records: BranchCommandRecords,
  draft: DraftRef,
): PendingBranchCommand | null {
  const record = records[branchCommandKey(draft)]?.claim;
  return record?.phase === "pending" ? (record.command ?? null) : null;
}

export function pendingChangeCommand(
  records: BranchCommandRecords,
  draft: DraftRef,
): PendingChangeCommand | null {
  const command = pendingBranchCommand(records, draft);
  return command?.target === "selection" ? command : null;
}

/** The drafts of this project's Work whose record differs between two snapshots. */
export function changedDrafts(
  records: BranchCommandRecords,
  previous: BranchCommandRecords,
  scope: BranchScope,
): DraftRef[] {
  const prefix = scopePrefix(scope);
  return [...new Set([...Object.keys(records), ...Object.keys(previous)])]
    .filter((key) => key.startsWith(prefix) && records[key] !== previous[key])
    .map((key) => {
      const [documentId = "", itemKey = ""] = key.slice(prefix.length).split("\u0000");
      return { ...scope, documentId, itemKey };
    });
}

/** Empty the store when a different account signs in; a no-op for the same one. */
export function bindBranchCommandAccount(accountId: string): void {
  if (boundAccountId === accountId) return;
  boundAccountId = accountId;
  resetBranchCommandRecords();
}

/** Clears what is shown and revokes every claim: an answer that arrives later has nothing to record into. */
export function resetBranchCommandRecords(): void {
  accountEpoch += 1;
  const unsent = Object.values(useBranchCommandStore.getState().queued);
  useBranchCommandStore.setState({ records: {}, queued: {}, drains: {}, unknown: {} });
  // A click that never got its turn is answered, not left waiting on a queue that is gone.
  for (const entry of unsent) entry.settle({ kind: "blocked" });
}

/**
 * Be told, synchronously, of every change to the records and what they were.
 * For state that must follow a command's claim and answer in the same tick
 * (a review's completion), which a render cannot promise.
 */
export function subscribeBranchCommandRecords(
  listener: (records: BranchCommandRecords, previous: BranchCommandRecords) => void,
): () => void {
  return useBranchCommandStore.subscribe((state, previous) => {
    if (state.records !== previous.records) listener(state.records, previous.records);
  });
}

/** The records right now, for code that is not a render (commands, tests). */
export function currentBranchCommandRecords(): BranchCommandRecords {
  return useBranchCommandStore.getState().records;
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
  /** The server could not finish this Apply (its batch is blocked). Terminal: never retried automatically. */
  | "blocked"
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
  drafts: BranchCommandRecords;
};

/** Every queued intent owns its addressed account capability and caller's promise. */
type QueuedSelection = {
  prefix: string;
  mode: ChangeCommandMode;
  epoch: number;
  settle: (outcome: BranchCommandOutcome) => void;
} & (
  | ({
      target: "selection";
      send: (
        click: ChangeSelection & { change: QueuedChange },
        afterAnother: boolean,
      ) => Promise<BranchCommandOutcome>;
    } & ChangeSelection)
  | { target: "all"; send: () => Promise<BranchCommandOutcome>; reject: (error: unknown) => void }
);
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
    branchCommandKey(draft),
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
  const claim = beginBranchCommand(draft, {
    target: "selection",
    classIds: selection.classIds,
    admissionTokens: selection.admissionTokens,
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

/** A proved same-member retry keeps its claim but addresses the newly observed generation. */
export function rebaseChangeCommand(
  claim: DraftClaim,
  selection: ChangeSelection,
  generation: number,
  completesDraft: boolean,
): void {
  if (!claimIsLive(claim)) return;
  updateDraftRecord(branchCommandKey(claim.draft), (prior) => {
    if (prior.claim?.phase !== "pending" || prior.claim.command.target !== "selection")
      return prior;
    return {
      ...prior,
      claim: {
        phase: "pending",
        token: claim.token,
        command: {
          target: "selection",
          mode: prior.claim.command.mode,
          ...selection,
          draftGeneration: generation,
          ...(completesDraft ? { completesDraft: true } : {}),
        },
      },
    };
  });
}

/** Queued selections hide immediately; each retains its caller's execution context and retires with its claim. */
export function queueChangeSelection(
  draft: DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
  settle: (outcome: BranchCommandOutcome) => void,
  send: Extract<QueuedSelection, { target: "selection" }>["send"],
): QueuedChange {
  const id = nextQueued++;
  const entry: QueuedSelection = {
    classIds: [...selection.classIds],
    admissionTokens: [...selection.admissionTokens],
    operationIds: [...selection.operationIds],
    keys: [...selectionKeys(selection)],
    send,
    target: "selection",
    prefix: branchCommandKey(draft),
    mode,
    epoch: accountEpoch,
    settle,
  };
  useBranchCommandStore.setState((state) => ({ queued: { ...state.queued, [id]: entry } }));
  return { id, epoch: accountEpoch, retire: () => retireQueuedSelection(id) };
}

/** A queued selection's capability: live only while it is still queued in the account epoch it was made in. */
export type QueuedChange = { id: number; epoch: number; retire: () => void };

export function retireQueuedSelection(id: number): void {
  if (!(id in useBranchCommandStore.getState().queued)) return;
  useBranchCommandStore.setState((state) => {
    const { [id]: _retired, ...rest } = state.queued;
    return { queued: rest };
  });
}

export function queuedChangeIsLive(change: Pick<QueuedChange, "id" | "epoch">): boolean {
  return change.epoch === accountEpoch && change.id in useBranchCommandStore.getState().queued;
}

/** Become the one loop sending this draft's queued clicks; null while another is. */
export function beginIntentDrain(draft: DraftRef): symbol | null {
  const key = branchCommandKey(draft);
  if (useBranchCommandStore.getState().drains[key]) return null;
  const token = Symbol(key);
  useBranchCommandStore.setState((state) => ({ drains: { ...state.drains, [key]: token } }));
  return token;
}

export function intentDrainCurrent(draft: DraftRef, token: symbol): boolean {
  return useBranchCommandStore.getState().drains[branchCommandKey(draft)] === token;
}

export function endIntentDrain(draft: DraftRef, token: symbol): void {
  if (!intentDrainCurrent(draft, token)) return;
  useBranchCommandStore.setState((state) => {
    const { [branchCommandKey(draft)]: _done, ...drains } = state.drains;
    return { drains };
  });
}

/** Submit a whole-draft intent to the same queue as selective clicks. */
export function queueWholeDraft(
  draft: DraftRef,
  mode: ChangeCommandMode,
  send: () => Promise<BranchCommandOutcome>,
  settle: (outcome: BranchCommandOutcome) => void,
  reject: (error: unknown) => void,
): void {
  const id = nextQueued++;
  useBranchCommandStore.setState((state) => ({
    queued: {
      ...state.queued,
      [id]: {
        target: "all",
        prefix: branchCommandKey(draft),
        mode,
        epoch: accountEpoch,
        send,
        settle,
        reject,
      },
    },
  }));
}

/** The writer's oldest intent on this draft that has not been sent yet. */
export function nextQueuedClick(
  draft: DraftRef,
): (QueuedSelection & { change: QueuedChange }) | null {
  const prefix = branchCommandKey(draft);
  for (const [id, entry] of Object.entries(useBranchCommandStore.getState().queued)) {
    if (entry.prefix === prefix)
      return {
        ...entry,
        change: {
          id: Number(id),
          epoch: entry.epoch,
          retire: () => retireQueuedSelection(Number(id)),
        },
      };
  }
  return null;
}

/** Only a whole intent on this draft holds its selective controls. */
export function wholeDraftPending(records: ChangeCommandRecords, draft: DraftRef): boolean {
  return (
    pendingBranchCommand(records.drafts, draft)?.target === "all" ||
    Object.values(records.queued).some(
      (entry) => entry.prefix === branchCommandKey(draft) && entry.target === "all",
    )
  );
}

export function failChangeCommand(
  by: DraftClaim | DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
  code: ChangeFailureCode,
  refusal?: ServerRefusal,
): void {
  if (!mayRecord(by)) return;
  setChangeRecord(draftOf(by), selection, (at) => ({
    phase: "failed",
    mode,
    code,
    ...(refusal ? { serverCode: refusal.serverCode } : {}),
    ...(refusal?.serverReason ? { serverReason: refusal.serverReason } : {}),
    at,
    classIds: selection.classIds,
    admissionTokens: selection.admissionTokens,
    operationIds: selection.operationIds,
    ...(selection.keys ? { keys: selection.keys } : {}),
  }));
}

export function confirmChangeCommand(
  by: DraftClaim | DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
): void {
  if (!mayRecord(by)) return;
  setChangeRecord(draftOf(by), selection, (at) => ({
    phase: "confirmed",
    mode,
    at,
    classIds: selection.classIds,
    admissionTokens: selection.admissionTokens,
    operationIds: selection.operationIds,
    ...(selection.keys ? { keys: selection.keys } : {}),
  }));
}

type FailedRecord = Extract<ChangeCommandRecord, { phase: "failed" }>;

/** The two selections name a change in common. */
function overlaps(left: ChangeSelection, right: ChangeSelection): boolean {
  const keys = new Set(selectionKeys(right));
  return selectionKeys(left).some((key) => keys.has(key));
}

/** Regrouped classes keep failures through operation overlap; unrelated changes do not inherit them. */
function failuresOfSelection(
  records: BranchCommandRecords,
  draft: DraftRef,
  selection: ChangeSelection,
): { key: string; record: FailedRecord }[] {
  return Object.entries(records[branchCommandKey(draft)]?.outcomes ?? {}).flatMap(
    ([key, record]) =>
      record.phase === "failed" && overlaps(record, selection) ? [{ key, record }] : [],
  );
}

/** Retire only failures that overlap the writer's next action. */
export function clearChangeFailure(draft: DraftRef, selection: ChangeSelection): void {
  updateDraftRecord(branchCommandKey(draft), (prior) => {
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
  const fence = useBranchCommandStore.getState().clock;
  const epoch = accountEpoch;
  const preview = await read();
  observations.set(preview, { fence, epoch });
  if (!accountEpochIs(epoch)) return preview;
  if (preview.status === "active")
    dropFailuresWithoutOperations(branchCommandKey(draft), preview, fence);
  return preview;
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
  const drafts = useBranchCommandRecords();
  const queued = useBranchCommandStore((state) => state.queued);
  return useMemo(() => ({ drafts, queued }), [drafts, queued]);
}

export function currentChangeCommandRecords(): ChangeCommandRecords {
  const { records: drafts, queued } = useBranchCommandStore.getState();
  return { drafts, queued };
}

/**
 * What the writer has done to this draft's changes, by key: those queued,
 * pending or confirmed are `hidden`, and of them the Discards are `restoring`
 * (the editor draws their original text until the next generation paints).
 */
export function intentKeys(
  records: ChangeCommandRecords,
  draft: DraftRef,
  confirmedOnly = false,
): DraftIntentKeys {
  const key = branchCommandKey(draft);
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
  if (confirmedOnly) return { hidden, restoring };
  for (const queued of Object.values(records.queued))
    if (queued.prefix === key && queued.target === "selection") add(queued, queued.mode);
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
