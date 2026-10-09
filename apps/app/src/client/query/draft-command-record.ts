/**
 * The one command record per draft (project, Work, document, draft), shared by
 * every surface (composer strip, editor header, Work Files) and every review
 * scope. A surface is disabled only by commands inside its own Work.
 *
 * - `pending`: an Apply or Discard is dispatched, whole-draft or a selection of
 *   changes (with its operation set). Every surface of that Work disables, and a second
 *   dispatch for the same draft, from any session, is refused instead of sent.
 *   This is the one command authority per draft; `change-command-record` only
 *   reads it.
 * - `failed`: a whole-draft Apply was rejected (`apply-failed`), a Discard was
 *   refused, an Apply response was lost (`apply-unknown`), or opening Review
 *   failed (`review-failed`). The draft is still listed, so its row shows the
 *   message wherever the draft is listed, even after the review moved on.
 *   It clears on the next action on the draft (Discard retry, Apply; opening
 *   Review clears only a failed launch), and when a later draft-list read no longer lists the draft. That
 *   absence is not evidence of Apply (a remote Discard looks the same), so the
 *   record never turns unknown into success; it only stops showing a message
 *   on a row that is gone.
 * - `confirmed`: the server confirmed Apply. Draft-list reads that started
 *   before the confirmation can no longer bring the draft back, so the record
 *   lives only until those reads settle. A read that started after it is
 *   authoritative, because the server reuses a draft id for the next
 *   generation of proposals.
 *
 * The store belongs to one account: `bindDraftCommandAccount` empties it when
 * the signed-in account changes.
 */
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

/**
 * A selection command in flight, with the operation set it sends. This is the
 * one place its identity, mode and coverage are readable from, by whichever
 * review has the draft open (`completesDraft`: the selection handles every
 * change the draft shows, so the draft may close), and where the server's
 * answer lands (`draftClosed`) before any list read follows it. The claim
 * remembers the draft generation it was sent against (`draftGeneration`, from
 * the preview the writer saw): its completion belongs to that generation, not
 * to a proposal that reuses the draft's id before the claim ends.
 */
export type PendingChangeCommand = ChangeSelection & {
  mode: ChangeCommandMode;
  draftGeneration: number;
  completesDraft?: true;
  draftClosed?: ClosedDraft;
};

type DraftCommandRecord =
  | { phase: "pending"; change?: PendingChangeCommand }
  | { phase: "failed"; failure: DraftCommandFailure; at: number }
  | { phase: "confirmed"; at: number };

export type DraftCommandRecords = Readonly<Record<string, DraftCommandRecord>>;

const useDraftCommandStore = create<{ records: DraftCommandRecords; clock: number }>(() => ({
  records: {},
  clock: 0,
}));

let boundAccountId: string | null = null;
/** Draft-list reads that have started and not settled, by the clock they started at. */
const readsInFlight = new Set<{ fence: number }>();

function scopePrefix({ projectId, workId }: DraftScope): string {
  return `${projectId}\u0000${workId}\u0000`;
}

export function draftCommandKey(draft: DraftRef): string {
  return `${scopePrefix(draft)}${draft.documentId}\u0000${draft.draftId}`;
}

function setRecord(
  draft: DraftRef,
  record: (clock: number) => DraftCommandRecord | null,
  advance = false,
): void {
  const key = draftCommandKey(draft);
  useDraftCommandStore.setState((state) => {
    const { [key]: _prior, ...rest } = state.records;
    const clock = advance ? state.clock + 1 : state.clock;
    const next = record(clock);
    return { records: next ? { ...rest, [key]: next } : rest, clock };
  });
}

function recordFor(draft: DraftRef): DraftCommandRecord | undefined {
  return useDraftCommandStore.getState().records[draftCommandKey(draft)];
}

/**
 * Claim the draft for one command: a whole-draft Apply or Discard, or, with
 * `change`, a selection's. One command at a time per draft, whichever
 * surface or session sends it; false when one is already in flight.
 */
export function beginDraftCommand(draft: DraftRef, change?: PendingChangeCommand): boolean {
  if (recordFor(draft)?.phase === "pending") return false;
  setRecord(draft, () => ({ phase: "pending", ...(change ? { change } : {}) }));
  return true;
}

/**
 * The server answered the selection command in flight on this draft and
 * closed the draft. Reviews showing it settle on this before the draft list is
 * re-read (`subscribeDraftCommandRecords`).
 */
export function answerDraftCommandClosed(draft: DraftRef, closed: ClosedDraft): void {
  const record = recordFor(draft);
  if (record?.phase !== "pending" || !record.change) return;
  const change = { ...record.change, draftClosed: closed };
  setRecord(draft, () => ({ phase: "pending", change }));
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
  setRecord(draft, (at) => ({ phase: "failed", failure, at }), true);
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
  setRecord(draft, (at) => ({ phase: "confirmed", at }), true);
  retireConfirmations();
}

/** A confirmation only fences reads that started before it; drop it once none is left. */
function retireConfirmations(): void {
  const oldest = Math.min(...Array.from(readsInFlight, (read) => read.fence));
  const { records } = useDraftCommandStore.getState();
  const kept = Object.entries(records).filter(
    ([, record]) => record.phase !== "confirmed" || record.at > oldest,
  );
  if (kept.length < Object.keys(records).length) {
    useDraftCommandStore.setState({ records: Object.fromEntries(kept) });
  }
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
  const inFlight = { fence: useDraftCommandStore.getState().clock };
  readsInFlight.add(inFlight);
  try {
    const listed = await read();
    const { records } = useDraftCommandStore.getState();
    const drafts = listed.filter((draft) => {
      const record = records[draftCommandKey({ ...scope, ...draft })];
      return record?.phase !== "confirmed" || record.at <= inFlight.fence;
    });
    const stillListed = new Set(drafts.map((draft) => draftCommandKey({ ...scope, ...draft })));
    const prefix = scopePrefix(scope);
    const gone = Object.entries(records).filter(
      ([key, record]) =>
        record.phase === "failed" &&
        record.at <= inFlight.fence &&
        key.startsWith(prefix) &&
        !stillListed.has(key),
    );
    if (gone.length > 0) {
      const dropped = new Set(gone.map(([key]) => key));
      useDraftCommandStore.setState((state) => ({
        records: Object.fromEntries(
          Object.entries(state.records).filter(([key]) => !dropped.has(key)),
        ),
      }));
    }
    return drafts;
  } finally {
    readsInFlight.delete(inFlight);
    retireConfirmations();
  }
}

/** Every held record; look rows up with `draftCommandKey`. */
export function useDraftCommandRecords(): DraftCommandRecords {
  return useDraftCommandStore((state) => state.records);
}

export function draftCommandFailure(
  records: DraftCommandRecords,
  draft: DraftRef,
): DraftCommandFailure | null {
  const record = records[draftCommandKey(draft)];
  return record?.phase === "failed" ? record.failure : null;
}

/** The selection command in flight on this draft, if the claim is one. */
export function pendingChangeCommand(
  records: DraftCommandRecords,
  draft: DraftRef,
): PendingChangeCommand | null {
  const record = records[draftCommandKey(draft)];
  return record?.phase === "pending" ? (record.change ?? null) : null;
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
  return Object.entries(records).some(
    ([key, record]) => record.phase === "pending" && key.startsWith(prefix),
  );
}

/** Empty the store when a different account signs in; a no-op for the same one. */
export function bindDraftCommandAccount(accountId: string): void {
  if (boundAccountId === accountId) return;
  boundAccountId = accountId;
  resetDraftCommandRecords();
}

const resetListeners = new Set<() => void>();

/** Stores that hold state beside this one (`change-command-record`) empty with it. */
export function onDraftCommandRecordsReset(listener: () => void): void {
  resetListeners.add(listener);
}

export function resetDraftCommandRecords(): void {
  useDraftCommandStore.setState({ records: {} });
  for (const listener of resetListeners) listener();
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
