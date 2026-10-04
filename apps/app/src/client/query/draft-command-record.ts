/**
 * The one command record per draft (documentId + draftId), shared by every
 * surface (composer strip, editor header, Work Files) and every review scope.
 *
 * - `pending`: an Apply or Discard is dispatched. Every surface disables, and a
 *   second dispatch for the same draft is refused instead of sent twice.
 * - `failed`: a Discard was refused, or an Apply response was lost
 *   (`apply-unknown`). The draft is still listed, so its row shows the message.
 *   It clears on the next action on the draft (Discard retry, Apply, opening
 *   Review). A draft leaving the list is not evidence of Apply (a remote
 *   Discard looks the same), so the record never turns unknown into success.
 * - `confirmed`: the server confirmed Apply. Draft-list reads that started
 *   before the confirmation can no longer bring the draft back. A read that
 *   started after it is authoritative, because the server reuses a draft id for
 *   the next generation of proposals.
 */
import { create } from "zustand";

type DraftRef = { documentId: string; draftId: string };

export type DraftCommandFailureCode = "apply-unknown" | "discard-offline";

type DraftCommandRecord =
  | { phase: "pending" }
  | { phase: "failed"; code: DraftCommandFailureCode }
  | { phase: "confirmed"; at: number };

type DraftCommandRecords = Readonly<Record<string, DraftCommandRecord>>;

const useDraftCommandStore = create<{ records: DraftCommandRecords; sequence: number }>(() => ({
  records: {},
  sequence: 0,
}));

export function draftCommandKey({ documentId, draftId }: DraftRef): string {
  return `${documentId}\u0000${draftId}`;
}

function setRecord(draft: DraftRef, record: DraftCommandRecord | null): void {
  const key = draftCommandKey(draft);
  useDraftCommandStore.setState((state) => {
    const { [key]: _prior, ...rest } = state.records;
    return {
      records: record ? { ...rest, [key]: record } : rest,
      sequence: record?.phase === "confirmed" ? record.at : state.sequence,
    };
  });
}

function recordFor(draft: DraftRef): DraftCommandRecord | undefined {
  return useDraftCommandStore.getState().records[draftCommandKey(draft)];
}

/** Claim the draft for one command; false when one is already in flight anywhere. */
export function beginDraftCommand(draft: DraftRef): boolean {
  if (recordFor(draft)?.phase === "pending") return false;
  setRecord(draft, { phase: "pending" });
  return true;
}

/** Release a claim that ended without a confirmation or a held failure. */
export function releaseDraftCommand(draft: DraftRef): void {
  if (recordFor(draft)?.phase === "pending") setRecord(draft, null);
}

export function failDraftCommand(draft: DraftRef, code: DraftCommandFailureCode): void {
  setRecord(draft, { phase: "failed", code });
}

/** Drop a held failure (opening Review, dismissing it); never touches a claim. */
export function clearDraftCommandFailure(draft: DraftRef): void {
  if (recordFor(draft)?.phase === "failed") setRecord(draft, null);
}

export function confirmDraftCommand(draft: DraftRef): void {
  setRecord(draft, { phase: "confirmed", at: useDraftCommandStore.getState().sequence + 1 });
}

/** Token for a read about to start; pass it to `withoutConfirmedSince` with the result. */
export function draftReadFence(): number {
  return useDraftCommandStore.getState().sequence;
}

/** Remove drafts confirmed after the read behind `fence` started. */
export function withoutConfirmedSince<T extends DraftRef>(fence: number, drafts: T[]): T[] {
  const { records } = useDraftCommandStore.getState();
  return drafts.filter((draft) => {
    const record = records[draftCommandKey(draft)];
    return record?.phase !== "confirmed" || record.at <= fence;
  });
}

/** Every held record; look rows up with `draftCommandKey`. */
export function useDraftCommandRecords(): DraftCommandRecords {
  return useDraftCommandStore((state) => state.records);
}

export function draftCommandFailure(
  records: DraftCommandRecords,
  draft: DraftRef,
): DraftCommandFailureCode | null {
  const record = records[draftCommandKey(draft)];
  return record?.phase === "failed" ? record.code : null;
}

export function anyDraftCommandPending(records: DraftCommandRecords): boolean {
  return Object.values(records).some((record) => record.phase === "pending");
}

export function resetDraftCommandRecords(): void {
  useDraftCommandStore.setState({ records: {}, sequence: 0 });
}
