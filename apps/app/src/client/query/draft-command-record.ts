/**
 * Draft command records: the one lifecycle of Apply and item Discard, shared by every surface.
 *
 * A review's Discard is a local editor edit and leaves no record. Apply does, keyed by item:
 * - the changes it was sent for leave the screen at the click (`applied`). A change is named by its pin in
 *   the frame the writer clicked plus its content hash (`isSameChange`), never by its id: ids carry an
 *   occurrence rank, so after one of two identical changes applies the survivor takes the id the applied
 *   one had. They come back with the error on them if the Apply fails (`failures`, named the same way).
 *   Once the server confirms, an entry stays until the review's `review_base` has changed, which is how
 *   the review learns the change became base;
 * - a whole-item command holds one claim per item, from the click, covering preparation;
 * - what an Apply overrode in live is published per item (`overrode`), for whichever surface applied;
 * - a command whose outcome stayed unknown keeps its `commandId`, so the writer's retry of the same body
 *   asks the server for the first attempt's outcome instead of applying twice.
 * Records are account-scoped: a different account signing in revokes every claim, so a late answer has
 * nothing to publish into.
 */
import type { DraftOverride } from "@meridian/contracts/drafts";
import { useMemo } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import { isSameChange } from "@/core/editor/extensions/inline-review/model";

/** Live text an Apply replaced because both sides changed the same words. */
export type Overrode = readonly DraftOverride[];

type DraftScope = { projectId: string; workId: string };
export type DraftRef = DraftScope & { documentId: string; itemKey: string };

/**
 * What a held whole-item failure is, never its wording. `-offline`: the request never got there.
 * `-refused`: the server answered with a typed reason, carried beside the code. `-server-error`: it
 * answered with an error that gave no reason. `apply-unknown`: it may or may not have landed.
 * `apply-blocked`: the server could not finish the Apply (terminal, never retried automatically).
 * Wording is the render layer's (`ReviewMessageText`).
 */
export type DraftCommandFailureCode =
  | "apply-offline"
  | "apply-refused"
  | "apply-server-error"
  | "apply-unknown"
  | "apply-blocked"
  | "discard-offline"
  | "discard-refused"
  | "discard-server-error"
  | "discard-unknown"
  | "review-failed";

/** What a typed server refusal said, as the server sent it; the words are chosen when it is shown. */
export type ServerRefusal = { serverCode: string; serverReason?: string };
export type DraftCommandFailure = { code: DraftCommandFailureCode } & Partial<ServerRefusal>;

export type ChangeCommandMode = "apply" | "discard";

/** Why an Apply of changes did not land; the copy lives in the render layer. */
export type ChangeFailureCode =
  | "offline"
  | "gone"
  | "unknown"
  | "blocked"
  | "refused"
  | "server-error";
export type ChangeFailure = { code: ChangeFailureCode } & Partial<ServerRefusal>;

type Claim =
  | { phase: "pending"; mode: ChangeCommandMode; token: symbol }
  | { phase: "failed"; failure: DraftCommandFailure };

/** A change as the frame the writer clicked in showed it: its group id there and its pinned first mark. */
export type ChangeTarget = { id: string; pin: Y.RelativePosition };

/** A change the writer applied, as the frame they clicked in showed it. */
export type AppliedChange = ChangeTarget & {
  /** The `review_base` the clicked frame was computed against. */
  baseKey: string;
  /** `sent` until the answer; `settled` until the review's base differs from `baseKey`. */
  phase: "sent" | "settled";
  request: symbol;
};

type RecordedFailure = ChangeTarget & { failure: ChangeFailure };

type DraftRecord = {
  claim?: Claim;
  applied: readonly AppliedChange[];
  failures: readonly RecordedFailure[];
  overrode: Overrode;
};
export type DraftCommandRecords = Readonly<Record<string, DraftRecord>>;

type HeldCommand = { commandId: string; digest: string };

const useDraftCommandStore = create<{
  records: DraftCommandRecords;
  /** Commands whose outcome stayed unknown: the writer's retry of the same body reuses the id. */
  unknown: Readonly<Record<string, HeldCommand>>;
}>(() => ({ records: {}, unknown: {} }));

let accountEpoch = 0;
let boundAccountId: string | null = null;

/** A claim as the executor holds it across awaits. */
export type DraftClaim = {
  readonly draft: DraftRef;
  readonly epoch: number;
  readonly token: symbol;
};

export function draftCommandKey(draft: DraftRef): string {
  return `${draft.projectId}\u0000${draft.workId}\u0000${draft.documentId}\u0000${draft.itemKey}`;
}

const EMPTY_RECORD: DraftRecord = { applied: [], failures: [], overrode: [] };

function update(draft: DraftRef, change: (record: DraftRecord) => DraftRecord): void {
  const key = draftCommandKey(draft);
  useDraftCommandStore.setState((held) => {
    const { records } = held;
    const prior = records[key] ?? EMPTY_RECORD;
    const next = change(prior);
    // Returning the held state is zustand's no-op: no reader is woken for an unchanged record.
    if (next === prior) return held;
    const { [key]: _gone, ...rest } = records;
    const empty =
      !next.claim &&
      next.applied.length === 0 &&
      next.failures.length === 0 &&
      next.overrode.length === 0;
    return { ...held, records: empty ? rest : { ...records, [key]: next } };
  });
}

function recordFor(draft: DraftRef): DraftRecord | undefined {
  return useDraftCommandStore.getState().records[draftCommandKey(draft)];
}

// ---- the id a command carries ----

/**
 * The id a command carries. A retry of a command whose outcome stayed unknown, with the same body,
 * reuses its id so the server answers the first attempt's outcome; any other body is a new command.
 * `digest` is the body without its id.
 */
export function commandIdFor(draft: DraftRef, kind: string, digest: string): string {
  const held = useDraftCommandStore.getState().unknown[`${draftCommandKey(draft)}\u0000${kind}`];
  return held?.digest === digest ? held.commandId : crypto.randomUUID();
}

/** Keep (`unknown`) or drop the id of the command that just ended. */
export function retainUnknownCommand(
  draft: DraftRef,
  kind: string,
  held: HeldCommand | null,
): void {
  const key = `${draftCommandKey(draft)}\u0000${kind}`;
  useDraftCommandStore.setState((state) => {
    if (!held && !(key in state.unknown)) return state;
    const { [key]: _prior, ...rest } = state.unknown;
    return { ...state, unknown: held ? { ...rest, [key]: held } : rest };
  });
}

// ---- whole-item claims ----

/** Take the item's one claim, or null when a command is already in flight on it. */
export function beginDraftCommand(draft: DraftRef, mode: ChangeCommandMode): DraftClaim | null {
  if (recordFor(draft)?.claim?.phase === "pending") return null;
  const token = Symbol("draft-claim");
  update(draft, (record) => ({
    ...record,
    claim: { phase: "pending", mode, token },
    overrode: [],
  }));
  return { draft, epoch: accountEpoch, token };
}

export function claimIsLive(claim: DraftClaim): boolean {
  const held = recordFor(claim.draft)?.claim;
  return claim.epoch === accountEpoch && held?.phase === "pending" && held.token === claim.token;
}

/** The command ended: the claim goes and nothing is left on the item. */
export function releaseDraftCommand(claim: DraftClaim): void {
  if (!claimIsLive(claim)) return;
  update(claim.draft, ({ claim: _ended, ...record }) => record);
}

export function failDraftCommand(claim: DraftClaim, failure: DraftCommandFailure): void {
  if (claim.epoch !== accountEpoch) return;
  update(claim.draft, (record) => ({ ...record, claim: { phase: "failed", failure } }));
}

/** A review that could not open leaves its failure on the item, where its list rows show it. */
export function failDraftReviewLaunch(draft: DraftRef): void {
  update(draft, (record) =>
    record.claim?.phase === "pending"
      ? record
      : { ...record, claim: { phase: "failed", failure: { code: "review-failed" } } },
  );
}

export function clearDraftCommandFailure(draft: DraftRef): void {
  update(draft, (record) =>
    record.claim?.phase === "failed" ? { ...record, claim: undefined } : record,
  );
}

export function clearDraftReviewLaunchFailure(draft: DraftRef): void {
  const claim = recordFor(draft)?.claim;
  if (claim?.phase === "failed" && claim.failure.code === "review-failed")
    clearDraftCommandFailure(draft);
}

// ---- Apply of changes ----

/** One Apply request for some changes, as the executor holds it across awaits. */
export type ChangeClaim = {
  readonly draft: DraftRef;
  readonly epoch: number;
  readonly request: symbol;
  readonly targets: readonly ChangeTarget[];
};

const namesAny = (targets: readonly ChangeTarget[], held: ChangeTarget) =>
  targets.some((target) => isSameChange(held, target.id, target.pin));

/** The changes leave the screen at the click; the item is not finished until the answer. */
export function beginChangeApply(
  draft: DraftRef,
  targets: readonly ChangeTarget[],
  baseKey: string,
): ChangeClaim {
  const request = Symbol("change-apply");
  update(draft, (record) => ({
    ...record,
    applied: [
      ...record.applied,
      ...targets.map((target): AppliedChange => ({ ...target, baseKey, phase: "sent", request })),
    ],
    failures: record.failures.filter((held) => !namesAny(targets, held)),
    overrode: [],
  }));
  return { draft, epoch: accountEpoch, request, targets };
}

/** The request is live while its account is: an account change revokes every claim at once. */
export function changeClaimIsLive(claim: ChangeClaim): boolean {
  return claim.epoch === accountEpoch;
}

/** The server applied them: they stay off the screen until the review's base changes. */
export function settleChangeApply(claim: ChangeClaim): void {
  if (!changeClaimIsLive(claim)) return;
  update(claim.draft, (record) => ({
    ...record,
    applied: record.applied.map((entry) =>
      entry.request === claim.request ? { ...entry, phase: "settled" } : entry,
    ),
  }));
}

/** A change's failed Apply as the file says it: the same words as a whole-item Apply that failed. */
function fileFailureOf(failure: ChangeFailure): DraftCommandFailure | null {
  return failure.code === "gone" ? null : { ...failure, code: `apply-${failure.code}` };
}

/** The Apply did not land: the changes come back with the reason on them. */
export function failChangeApply(claim: ChangeClaim, failure: ChangeFailure): void {
  if (!changeClaimIsLive(claim)) return;
  update(claim.draft, (record) => ({
    ...record,
    applied: record.applied.filter((entry) => entry.request !== claim.request),
    failures: [
      ...record.failures.filter((held) => !namesAny(claim.targets, held)),
      ...claim.targets.map((target) => ({ ...target, failure })),
    ],
  }));
}

export function clearChangeFailure(draft: DraftRef, change: ChangeTarget): void {
  update(draft, (record) => {
    const failures = record.failures.filter((held) => !namesAny([change], held));
    return failures.length === record.failures.length ? record : { ...record, failures };
  });
}

/**
 * Forget what the review has moved past: a confirmed Apply once the review's base is not the one it was
 * clicked against (the base patch arrived: the change is base text now). `baseKey` is read only when
 * something confirmed is held.
 *
 * A failure whose change is gone from the frame (a peer removed it while the Apply waited) is not forgotten:
 * the Apply still did not land, so it moves to the file as its failure (`claim`), never onto a surviving
 * twin and never as a row. A file that already has a claim keeps it. A change the item no longer has
 * (`gone`) has nothing left to tell. Nothing here closes anything: absence from a list or a frame is
 * never evidence that an item closed.
 */
export function reconcileChangeRecords(
  draft: DraftRef,
  listed: readonly ChangeTarget[],
  baseKey: () => string,
): void {
  update(draft, (record) => {
    const current = record.applied.some((entry) => entry.phase === "settled") ? baseKey() : null;
    const applied = record.applied.filter(
      (entry) => entry.phase === "sent" || entry.baseKey === current,
    );
    const failures = record.failures.filter((held) =>
      listed.some((change) => isSameChange(held, change.id, change.pin)),
    );
    const same =
      applied.length === record.applied.length && failures.length === record.failures.length;
    if (same) return record;
    const unplaced = record.failures.find((held) => !failures.includes(held));
    const promoted = unplaced && !record.claim ? fileFailureOf(unplaced.failure) : null;
    return {
      ...record,
      applied,
      failures,
      ...(promoted ? { claim: { phase: "failed" as const, failure: promoted } } : {}),
    };
  });
}

// ---- what an Apply overrode ----

/** Live text the last Apply of this item replaced; published whichever surface applied. */
export function noteOverrode(claim: { draft: DraftRef; epoch: number }, items: Overrode): void {
  if (claim.epoch !== accountEpoch || items.length === 0) return;
  update(claim.draft, (record) => ({ ...record, overrode: items }));
}

export function dismissOverrode(draft: DraftRef): void {
  update(draft, (record) => (record.overrode.length > 0 ? { ...record, overrode: [] } : record));
}

// ---- reads ----

const NO_RECORDS: DraftCommandRecords = {};
const NO_APPLIED: readonly AppliedChange[] = [];
const NO_OVERRODE: Overrode = [];

export function useDraftCommandRecords(): DraftCommandRecords {
  return useDraftCommandStore((state) => state.records);
}

export function currentDraftCommandRecords(): DraftCommandRecords {
  return useDraftCommandStore.getState().records;
}

/** Call `listener` after any record changes; for owners that are not React (the review runtime). */
export function watchDraftCommandRecords(listener: () => void): () => void {
  return useDraftCommandStore.subscribe((state, previous) => {
    if (state.records !== previous.records) listener();
  });
}

/** Only this item's records: a reader re-renders for its own item's commands, not every item's. */
export function useDraftCommandSlice(draft: DraftRef | null): DraftCommandRecords {
  const key = draft ? draftCommandKey(draft) : "";
  const record = useDraftCommandStore((state) => state.records[key]);
  return useMemo(() => (record ? { [key]: record } : NO_RECORDS), [key, record]);
}

/** The Applies of this item that have left the screen and are not yet part of the review's base. */
export function appliedChanges(
  records: DraftCommandRecords,
  draft: DraftRef,
): readonly AppliedChange[] {
  return records[draftCommandKey(draft)]?.applied ?? NO_APPLIED;
}

/** Applies sent and not yet answered: the item is not finished while any is out. */
export function sentChangeApplies(records: DraftCommandRecords, draft: DraftRef): number {
  return appliedChanges(records, draft).filter((entry) => entry.phase === "sent").length;
}

export function draftOverrode(records: DraftCommandRecords, draft: DraftRef): Overrode {
  return records[draftCommandKey(draft)]?.overrode ?? NO_OVERRODE;
}

/** Why the last Apply of this change did not land, found by the frame-bound identity it was clicked as. */
export function changeFailure(
  records: DraftCommandRecords,
  draft: DraftRef,
  change: ChangeTarget,
): ChangeFailure | null {
  const held = records[draftCommandKey(draft)]?.failures.find((entry) =>
    isSameChange(entry, change.id, change.pin),
  );
  return held?.failure ?? null;
}

export function draftCommandFailure(
  records: DraftCommandRecords,
  draft: DraftRef,
): DraftCommandFailure | null {
  const claim = records[draftCommandKey(draft)]?.claim;
  return claim?.phase === "failed" ? claim.failure : null;
}

/** The whole-item command in flight on this item, if any. */
export function pendingDraftCommand(
  records: DraftCommandRecords,
  draft: DraftRef,
): { mode: ChangeCommandMode } | null {
  const claim = records[draftCommandKey(draft)]?.claim;
  return claim?.phase === "pending" ? { mode: claim.mode } : null;
}

// ---- account ----

export function accountEpochIs(epoch: number): boolean {
  return epoch === accountEpoch;
}

export function currentAccountEpoch(): number {
  return accountEpoch;
}

/** Empty the store when a different account signs in; a no-op for the same one. */
export function bindDraftCommandAccount(accountId: string): void {
  if (boundAccountId === accountId) return;
  boundAccountId = accountId;
  resetDraftCommandRecords();
}

/** Clears what is shown and revokes every claim. */
export function resetDraftCommandRecords(): void {
  accountEpoch += 1;
  useDraftCommandStore.setState({ records: {}, unknown: {} });
}
