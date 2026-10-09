/** Shared draft commands, selection outcomes, batch leases and distinct list/preview read fences. */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useMemo } from "react";
import { create } from "zustand";

type DraftScope = { projectId: string; workId: string };
type DraftRef = DraftScope & { documentId: string; draftId: string };
type ListedDraft = { documentId: string; draftId: string };

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
export type ChangeSelection = { classIds: readonly string[]; operationIds: readonly string[] };

/**
 * What the server's closing answer left to say about the draft, read when it
 * landed: the draft leaves the Work's list once the answer's reads do.
 */
export type ClosedDraft = { documentName: string | null };

/** Selection identity, preview basis and addressed settlement, shared with every observing review. */
export type PendingChangeCommand = ChangeSelection & {
  target: "selection";
  basis?: { liveRevisionToken: string; draftRevisionToken: string };
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
  | { phase: "pending"; command: PendingDraftCommand }
  | { phase: "failed"; failure: DraftCommandFailure; at: number; command?: PendingDraftCommand }
  | { phase: "confirmed"; at: number; command?: PendingDraftCommand };

type DraftCommandRecord = {
  claim?: DraftClaimRecord;
  outcomes: Readonly<Record<string, ChangeCommandRecord>>;
};
export type DraftCommandRecords = Readonly<Record<string, DraftCommandRecord>>;

const useDraftCommandStore = create<{
  records: DraftCommandRecords;
  queued: QueuedSelections;
  batches: Readonly<Record<string, symbol>>;
  clock: number;
}>(() => ({
  records: {},
  queued: {},
  batches: {},
  clock: 0,
}));

let boundAccountId: string | null = null;
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
export function beginDraftCommand(draft: DraftRef, command: PendingDraftCommand): boolean {
  if (recordFor(draft)?.phase === "pending") return false;
  setRecord(draft, () => ({ phase: "pending", command }));
  return true;
}

/**
 * The server answered the selection command in flight on this draft and
 * closed the draft. Reviews showing it settle on this before the draft list is
 * re-read (`subscribeDraftCommandRecords`).
 */
export function answerDraftCommandClosed(draft: DraftRef, closed: ClosedDraft): void {
  const record = recordFor(draft);
  if (
    record?.phase !== "pending" ||
    !record.command ||
    (record.command.target === "all" && !record.command.completesDraft)
  )
    return;
  const change = { ...record.command, draftClosed: closed };
  setRecord(draft, () => ({ phase: "pending", command: change }));
}

/** Publish an addressed selection result before caches refresh or the claim is released. */
export function answerDraftSelection(
  draft: DraftRef,
  outcome: PendingChangeCommand["outcome"],
): void {
  const command = pendingChangeCommand(currentDraftCommandRecords(), draft);
  if (command) setRecord(draft, () => ({ phase: "pending", command: { ...command, outcome } }));
}

/**
 * Release a claim that ended without a confirmation or a held failure. The
 * server's closing answer ends with the claim: the id it closed is reused for
 * the next proposal, so nothing outlives the claim to be mistaken for it.
 */
export function releaseDraftCommand(draft: DraftRef): void {
  if (recordFor(draft)?.phase === "pending") setRecord(draft, () => null);
}

export function failDraftCommand(draft: DraftRef, failure: DraftCommandFailure): void {
  const change = recordFor(draft)?.command;
  setRecord(
    draft,
    (at) => ({ phase: "failed", failure, at, ...(change ? { command: change } : {}) }),
    true,
  );
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

export function confirmDraftCommand(draft: DraftRef): void {
  const change = recordFor(draft)?.command;
  setRecord(
    draft,
    (at) => ({ phase: "confirmed", at, ...(change ? { command: change } : {}) }),
    true,
  );
  retireConfirmations();
}

/** List and preview confirmations have distinct consumers, but one retention clock. */
function retireConfirmations(): void {
  const oldest = (kind: "list" | "preview") =>
    Math.min(
      ...Array.from(readsInFlight)
        .filter((read) => read.kind === kind)
        .map((read) => read.fence),
    );
  const listFence = oldest("list");
  const previewFence = oldest("preview");
  useDraftCommandStore.setState((state) => ({
    records: Object.fromEntries(
      Object.entries(state.records).flatMap(([key, record]) => {
        const claim =
          record.claim?.phase === "confirmed" && record.claim.at <= listFence
            ? undefined
            : record.claim;
        const outcomes = Object.fromEntries(
          Object.entries(record.outcomes).filter(
            ([, outcome]) => outcome.phase !== "confirmed" || outcome.at > previewFence,
          ),
        );
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
      return record?.phase !== "confirmed" || record.at <= inFlight.fence;
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

/** Empty the store when a different account signs in; a no-op for the same one. */
export function bindDraftCommandAccount(accountId: string): void {
  if (boundAccountId === accountId) return;
  boundAccountId = accountId;
  resetDraftCommandRecords();
}

export function resetDraftCommandRecords(): void {
  useDraftCommandStore.setState({ records: {}, queued: {}, batches: {} });
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
  | "gone"
  /** A new document's changes cannot be applied one by one. */
  | "draft-only";

type ChangeCommandRecord = ChangeSelection & {
  draftGeneration?: number;
  basis?: PendingChangeCommand["basis"];
} & (
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

/** A selection sent in a batch that has not had its turn: hidden, not claimed. */
type QueuedSelection = { prefix: string; operationIds: readonly string[] };
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
      const command = prior.claim?.command;
      const record = {
        ...outcome(clock),
        ...(command?.target === "selection"
          ? { draftGeneration: command.draftGeneration, basis: command.basis }
          : {}),
      };
      return { ...prior, outcomes: { ...prior.outcomes, [recordKey(selection)]: record } };
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
  basis?: PendingChangeCommand["basis"],
): boolean {
  if (
    !beginDraftCommand(draft, {
      target: "selection",
      basis,
      classIds: selection.classIds,
      operationIds: selection.operationIds,
      mode,
      draftGeneration,
      ...(completesDraft ? { completesDraft: true as const } : {}),
    })
  ) {
    return false;
  }
  // The claim is the next action on these changes: a failure they held is stale now.
  clearChangeFailure(draft, selection);
  return true;
}

/** Queued selections hide immediately; each retires when its claim starts or the batch ends. */
export function queueChangeSelection(draft: DraftRef, selection: ChangeSelection): () => void {
  const id = nextQueued++;
  const entry = { prefix: draftCommandKey(draft), operationIds: selection.operationIds };
  useDraftCommandStore.setState((state) => ({ queued: { ...state.queued, [id]: entry } }));
  return () => {
    if (!(id in useDraftCommandStore.getState().queued)) return;
    useDraftCommandStore.setState((state) => {
      const { [id]: _retired, ...rest } = state.queued;
      return { queued: rest };
    });
  };
}

/** Give back a claim that ended without a confirmation or a held failure. */
export function releaseChangeCommand(draft: DraftRef): void {
  releaseDraftCommand(draft);
}

export function failChangeCommand(
  draft: DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
  code: ChangeFailureCode,
  refusal?: ServerRefusal,
): void {
  setChangeRecord(draft, selection, (at) => ({
    phase: "failed",
    mode,
    code,
    ...(refusal ? { serverCode: refusal.serverCode } : {}),
    ...(refusal?.serverReason ? { serverReason: refusal.serverReason } : {}),
    at,
    classIds: selection.classIds,
    operationIds: selection.operationIds,
  }));
}

export function confirmChangeCommand(
  draft: DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
): void {
  setChangeRecord(draft, selection, (at) => ({
    phase: "confirmed",
    mode,
    at,
    classIds: selection.classIds,
    operationIds: selection.operationIds,
  }));
  retireConfirmations();
}

type FailedRecord = Extract<ChangeCommandRecord, { phase: "failed" }>;

/** The two selections name a class or an operation in common (the server may have regrouped since). */
function overlaps(left: ChangeSelection, right: ChangeSelection): boolean {
  const classIds = new Set(right.classIds);
  const operationIds = new Set(right.operationIds);
  return (
    left.classIds.some((id) => classIds.has(id)) ||
    left.operationIds.some((id) => operationIds.has(id))
  );
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

type ActivePreview = Extract<DraftPreviewResponse, { status: "active" }>;

/**
 * The preview without the operations (and the hunks only they own) in `hidden`.
 * A hunk no operation owns (unclassified) is nobody's to hide: it stays.
 */
export function previewWithoutOperations(
  preview: DraftPreviewResponse,
  hidden: ReadonlySet<string>,
): DraftPreviewResponse {
  if (preview.status !== "active" || hidden.size === 0) return preview;
  const operations = preview.operations.filter((op) => !hidden.has(op.operationId));
  const hunks = preview.hunks.flatMap((hunk) => {
    const operationIds = hunk.operationIds.filter((id) => !hidden.has(id));
    if (hunk.operationIds.length > 0 && operationIds.length === 0) return [];
    if (operationIds.length === hunk.operationIds.length) return [hunk];
    return [
      hunk.kind === "text"
        ? {
            ...hunk,
            operationIds,
            spans: hunk.spans.filter((span) => !hidden.has(span.operationId)),
          }
        : { ...hunk, operationIds },
    ];
  });
  return { ...preview, operations, hunks } satisfies ActivePreview;
}

/**
 * Run one preview read. Changes confirmed after the read started are removed
 * from its result, so a read that was already in flight when the writer applied
 * or discarded a change cannot bring it back.
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
    const hidden = new Set<string>();
    for (const record of Object.values(
      useDraftCommandStore.getState().records[prefix]?.outcomes ?? {},
    )) {
      if (record.phase !== "confirmed" || record.at <= inFlight.fence) {
        continue;
      }
      for (const id of record.operationIds) hidden.add(id);
    }
    // A failure held for a change the preview no longer lists describes nothing.
    if (preview.status === "active") dropFailuresWithoutOperations(prefix, preview, inFlight.fence);
    return previewWithoutOperations(preview, hidden);
  } finally {
    readsInFlight.delete(inFlight);
    retireConfirmations();
  }
}

function dropFailuresWithoutOperations(key: string, preview: ActivePreview, fence: number): void {
  const listed = new Set(preview.operations.map((op) => op.operationId));
  updateDraftRecord(key, (prior) => {
    const outcomes = Object.fromEntries(
      Object.entries(prior.outcomes).filter(
        ([, record]) =>
          record.phase !== "failed" ||
          record.at > fence ||
          record.operationIds.some((id) => listed.has(id)),
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

/** The operations hidden from this draft's preview: every change queued, pending or confirmed. */
export function hiddenOperationIds(
  records: ChangeCommandRecords,
  draft: DraftRef,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const record of Object.values(records.drafts[draftCommandKey(draft)]?.outcomes ?? {})) {
    if (record.phase === "failed") continue;
    for (const id of record.operationIds) hidden.add(id);
  }
  const prefix = draftCommandKey(draft);
  for (const queued of Object.values(records.queued)) {
    if (queued.prefix === prefix) for (const id of queued.operationIds) hidden.add(id);
  }
  for (const id of pendingChangeCommand(records.drafts, draft)?.operationIds ?? []) hidden.add(id);
  return hidden;
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
