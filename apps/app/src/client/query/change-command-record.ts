/**
 * The one command record per change under review (a server closure class),
 * shared by every surface that shows it: the manuscript's marks and bar, the
 * change list, the stepper, the header counts. Sits beside
 * `draft-command-record`, which does the same for whole drafts.
 *
 * - `pending`: an Apply or Discard of this change is dispatched. The change
 *   leaves every surface at once (the writer sees the result of the click) and
 *   a second command for it is refused instead of sent twice.
 * - `failed`: the command did not land. The change comes back, showing why on
 *   its own bar and row. It clears on the next action on that change, and when
 *   a later preview no longer lists any of its operations.
 * - `confirmed`: the server confirmed the command. Preview reads that started
 *   before the confirmation can no longer bring the change back (a read in
 *   flight from before the click resolves with the change still in it), so the
 *   record lives only until those reads settle. A read that started after it is
 *   authoritative.
 *
 * A change is identified by its operations, not only by its class id: a class
 * the server regroups after a refusal keeps some of the same operations, and
 * the message belongs to the change the writer was looking at.
 *
 * The store belongs to one account: `bindDraftCommandAccount` (in
 * `draft-command-record`) empties it by calling `resetChangeCommandRecords`.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { create } from "zustand";

type DraftRef = { projectId: string; workId: string; documentId: string; draftId: string };

export type ChangeCommandMode = "apply" | "discard";

/** Why a change command did not land; the copy lives in the render layer. */
export type ChangeFailureCode =
  /** The request got no answer, or the server failed. */
  | "offline"
  /** The change was updated under the writer; the preview is re-read. */
  | "stale"
  /** The change is no longer in the draft. */
  | "gone"
  /** A new document's changes cannot be applied one by one. */
  | "draft-only";

export type ChangeRef = { classId: string; operationIds: readonly string[] };

type ChangeCommandRecord = ChangeRef &
  (
    | { phase: "pending"; mode: ChangeCommandMode }
    | { phase: "failed"; mode: ChangeCommandMode; code: ChangeFailureCode; at: number }
    | { phase: "confirmed"; mode: ChangeCommandMode; at: number }
  );

export type ChangeCommandState =
  | { phase: "pending"; mode: ChangeCommandMode }
  | { phase: "failed"; mode: ChangeCommandMode; code: ChangeFailureCode };

type ChangeRecords = Readonly<Record<string, ChangeCommandRecord>>;

const useChangeCommandStore = create<{ records: ChangeRecords; clock: number }>(() => ({
  records: {},
  clock: 0,
}));

/** Preview reads that started and have not settled, by the clock they started at. */
const readsInFlight = new Set<{ fence: number }>();

function draftPrefix(draft: DraftRef): string {
  return `${draft.projectId}\u0000${draft.workId}\u0000${draft.documentId}\u0000${draft.draftId}\u0000`;
}

function recordKey(draft: DraftRef, classId: string): string {
  return `${draftPrefix(draft)}${classId}`;
}

function setRecord(
  draft: DraftRef,
  change: ChangeRef,
  record: ((clock: number) => ChangeCommandRecord) | null,
  advance = false,
): void {
  const key = recordKey(draft, change.classId);
  useChangeCommandStore.setState((state) => {
    const { [key]: _prior, ...rest } = state.records;
    const clock = advance ? state.clock + 1 : state.clock;
    return { records: record ? { ...rest, [key]: record(clock) } : rest, clock };
  });
}

function recordFor(draft: DraftRef, classId: string): ChangeCommandRecord | undefined {
  return useChangeCommandStore.getState().records[recordKey(draft, classId)];
}

/** Claim the change for one command; false when one is already in flight on it. */
export function beginChangeCommand(
  draft: DraftRef,
  change: ChangeRef,
  mode: ChangeCommandMode,
): boolean {
  if (recordFor(draft, change.classId)?.phase === "pending") return false;
  setRecord(draft, change, () => ({
    phase: "pending",
    mode,
    classId: change.classId,
    operationIds: change.operationIds,
  }));
  return true;
}

/** Give back a claim that ended without a confirmation or a held failure. */
export function releaseChangeCommand(draft: DraftRef, change: ChangeRef): void {
  if (recordFor(draft, change.classId)?.phase === "pending") setRecord(draft, change, null);
}

export function failChangeCommand(
  draft: DraftRef,
  change: ChangeRef,
  mode: ChangeCommandMode,
  code: ChangeFailureCode,
): void {
  setRecord(
    draft,
    change,
    (at) => ({
      phase: "failed",
      mode,
      code,
      at,
      classId: change.classId,
      operationIds: change.operationIds,
    }),
    true,
  );
}

export function confirmChangeCommand(
  draft: DraftRef,
  change: ChangeRef,
  mode: ChangeCommandMode,
): void {
  setRecord(
    draft,
    change,
    (at) => ({
      phase: "confirmed",
      mode,
      at,
      classId: change.classId,
      operationIds: change.operationIds,
    }),
    true,
  );
  retireConfirmations();
}

/** Drop a held failure (the next action on the change, a dismissal); never touches a claim. */
export function clearChangeFailure(draft: DraftRef, change: ChangeRef): void {
  if (recordFor(draft, change.classId)?.phase === "failed") setRecord(draft, change, null);
}

/** A confirmation only fences reads that started before it; drop it once none is left. */
function retireConfirmations(): void {
  const oldest = Math.min(...Array.from(readsInFlight, (read) => read.fence));
  const { records } = useChangeCommandStore.getState();
  const kept = Object.entries(records).filter(
    ([, record]) => record.phase !== "confirmed" || record.at > oldest,
  );
  if (kept.length < Object.keys(records).length) {
    useChangeCommandStore.setState({ records: Object.fromEntries(kept) });
  }
}

type ActivePreview = Extract<DraftPreviewResponse, { status: "active" }>;

/** The preview without the operations (and the hunks only they own) in `hidden`. */
export function previewWithoutOperations(
  preview: DraftPreviewResponse,
  hidden: ReadonlySet<string>,
): DraftPreviewResponse {
  if (preview.status !== "active" || hidden.size === 0) return preview;
  const operations = preview.operations.filter((op) => !hidden.has(op.operationId));
  const hunks = preview.hunks.flatMap((hunk) => {
    const operationIds = hunk.operationIds.filter((id) => !hidden.has(id));
    if (operationIds.length === 0) return [];
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
  const inFlight = { fence: useChangeCommandStore.getState().clock };
  readsInFlight.add(inFlight);
  try {
    const preview = await read();
    const prefix = draftPrefix(draft);
    const hidden = new Set<string>();
    for (const [key, record] of Object.entries(useChangeCommandStore.getState().records)) {
      if (!key.startsWith(prefix) || record.phase !== "confirmed" || record.at <= inFlight.fence) {
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

function dropFailuresWithoutOperations(
  prefix: string,
  preview: ActivePreview,
  fence: number,
): void {
  const listed = new Set(preview.operations.map((op) => op.operationId));
  const { records } = useChangeCommandStore.getState();
  const gone = Object.entries(records).filter(
    ([key, record]) =>
      record.phase === "failed" &&
      record.at <= fence &&
      key.startsWith(prefix) &&
      !record.operationIds.some((id) => listed.has(id)),
  );
  if (gone.length === 0) return;
  const dropped = new Set(gone.map(([key]) => key));
  useChangeCommandStore.setState((state) => ({
    records: Object.fromEntries(Object.entries(state.records).filter(([key]) => !dropped.has(key))),
  }));
}

/** Every held record; look changes up with `changeCommandState`. */
export function useChangeCommandRecords(): ChangeRecords {
  return useChangeCommandStore((state) => state.records);
}

/** The records right now, for code that is not a render (commands, tests). */
export function currentChangeCommandRecords(): ChangeRecords {
  return useChangeCommandStore.getState().records;
}

function recordsOfDraft(records: ChangeRecords, draft: DraftRef): ChangeCommandRecord[] {
  const prefix = draftPrefix(draft);
  return Object.entries(records)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, record]) => record);
}

/** The operations hidden from this draft's preview: every change pending or confirmed. */
export function hiddenOperationIds(records: ChangeRecords, draft: DraftRef): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const record of recordsOfDraft(records, draft)) {
    if (record.phase === "failed") continue;
    for (const id of record.operationIds) hidden.add(id);
  }
  return hidden;
}

/** What a change's command record says, matched by class id or any shared operation. */
export function changeCommandState(
  records: ChangeRecords,
  draft: DraftRef,
  change: ChangeRef,
): ChangeCommandState | null {
  const own = records[recordKey(draft, change.classId)];
  const candidates = own ? [own] : recordsOfDraft(records, draft);
  const ids = new Set(change.operationIds);
  for (const record of candidates) {
    if (record.phase === "confirmed") continue;
    if (record !== own && !record.operationIds.some((id) => ids.has(id))) continue;
    return record.phase === "pending"
      ? { phase: "pending", mode: record.mode }
      : { phase: "failed", mode: record.mode, code: record.code };
  }
  return null;
}

/** Any change of this Work's draft is in flight. */
export function changeCommandPendingIn(records: ChangeRecords, draft: DraftRef): boolean {
  return recordsOfDraft(records, draft).some((record) => record.phase === "pending");
}

export function resetChangeCommandRecords(): void {
  useChangeCommandStore.setState({ records: {} });
  useClearedDraftStore.setState({ cleared: {} });
}

/**
 * Drafts the writer has handled to the last change. The server keeps such a
 * draft in its list, empty, until it is cleaned up; until then the writer must
 * not be offered it as pending (not in the switcher, not as the next draft).
 * The mark is the draft's last AI turn when it was cleared: a later AI write
 * moves that turn on, and the draft is pending again. Its document's name is
 * kept so the review that is still open can say what it is.
 */
type ClearedDraft = { lastActorTurnId: string | null; documentName: string | null };
type ClearedDrafts = Readonly<Record<string, ClearedDraft>>;

const useClearedDraftStore = create<{ cleared: ClearedDrafts }>(() => ({ cleared: {} }));

export function markDraftCleared(draft: DraftRef, cleared: ClearedDraft): void {
  useClearedDraftStore.setState((state) => ({
    cleared: { ...state.cleared, [draftPrefix(draft)]: cleared },
  }));
}

export function currentClearedDrafts(): ClearedDrafts {
  return useClearedDraftStore.getState().cleared;
}

export function useClearedDrafts(): ClearedDrafts {
  return useClearedDraftStore((state) => state.cleared);
}

/** The name of a cleared draft's document, for the review still open on it. */
export function clearedDraftName(cleared: ClearedDrafts, draft: DraftRef): string | null {
  return cleared[draftPrefix(draft)]?.documentName ?? null;
}

/** Whether a listed draft was already handled to its last change (and nothing new was written since). */
export function isDraftCleared(
  cleared: ClearedDrafts,
  draft: DraftRef,
  lastActorTurnId: string | null,
): boolean {
  const marked = cleared[draftPrefix(draft)];
  return marked !== undefined && marked.lastActorTurnId === lastActorTurnId;
}
