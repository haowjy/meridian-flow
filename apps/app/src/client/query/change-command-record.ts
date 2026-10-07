/**
 * What the writer sees of each change under review (a server closure class),
 * shared by every surface that shows it: the manuscript's marks and bar, the
 * change list, the stepper, the header counts. Sits beside
 * `draft-command-record`, which is the one command authority per draft.
 *
 * - `pending`: an Apply or Discard of this change is dispatched. It is not
 *   stored here: it is the draft's own pending claim (`beginDraftCommand`,
 *   carrying the change's operation set), so a whole-draft command, or a
 *   command from another session, cannot be sent beside it. The change leaves
 *   every surface at once (the writer sees the result of the click).
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
import { useMemo } from "react";
import { create } from "zustand";
import {
  beginDraftCommand,
  type ChangeCommandMode,
  type ChangeRef,
  currentDraftCommandRecords,
  type DraftCommandRecords,
  onDraftCommandRecordsReset,
  pendingChangeCommand,
  releaseDraftCommand,
  useDraftCommandRecords,
} from "./draft-command-record";

export type { ChangeCommandMode, ChangeRef };

type DraftRef = { projectId: string; workId: string; documentId: string; draftId: string };

/** Why a change command did not land; the copy lives in the render layer. */
export type ChangeFailureCode =
  /** The server refused the request or failed. */
  | "offline"
  /** An Apply got no answer: it may or may not have landed. Never read as a refusal. */
  | "unknown"
  /** The change was updated under the writer; the preview is re-read. */
  | "stale"
  /** The change is no longer in the draft. */
  | "gone"
  /** A new document's changes cannot be applied one by one. */
  | "draft-only";

type ChangeCommandRecord = ChangeRef &
  (
    | { phase: "failed"; mode: ChangeCommandMode; code: ChangeFailureCode; at: number }
    | { phase: "confirmed"; mode: ChangeCommandMode; at: number }
  );

export type ChangeCommandState =
  | { phase: "pending"; mode: ChangeCommandMode }
  | { phase: "failed"; mode: ChangeCommandMode; code: ChangeFailureCode };

type ChangeRecords = Readonly<Record<string, ChangeCommandRecord>>;

/** Everything that says what is happening to a draft's changes: held outcomes and the draft's own claim. */
export type ChangeCommandRecords = { changes: ChangeRecords; drafts: DraftCommandRecords };

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

/** Claim the draft for one command on this change; false when any command is in flight on the draft. */
export function beginChangeCommand(
  draft: DraftRef,
  change: ChangeRef,
  mode: ChangeCommandMode,
): boolean {
  if (
    !beginDraftCommand(draft, { classId: change.classId, operationIds: change.operationIds, mode })
  ) {
    return false;
  }
  // The claim is the next action on the change: a failure it held is stale now.
  clearChangeFailure(draft, change);
  return true;
}

/** Give back a claim that ended without a confirmation or a held failure. */
export function releaseChangeCommand(draft: DraftRef): void {
  releaseDraftCommand(draft);
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

/** Every held record and claim; look changes up with `changeCommandState`. */
export function useChangeCommandRecords(): ChangeCommandRecords {
  const changes = useChangeCommandStore((state) => state.records);
  const drafts = useDraftCommandRecords();
  return useMemo(() => ({ changes, drafts }), [changes, drafts]);
}

/** The records right now, for code that is not a render (commands, tests). */
export function currentChangeCommandRecords(): ChangeCommandRecords {
  return {
    changes: useChangeCommandStore.getState().records,
    drafts: currentDraftCommandRecords(),
  };
}

function recordsOfDraft(records: ChangeRecords, draft: DraftRef): ChangeCommandRecord[] {
  const prefix = draftPrefix(draft);
  return Object.entries(records)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, record]) => record);
}

/** The operations hidden from this draft's preview: every change pending or confirmed. */
export function hiddenOperationIds(
  records: ChangeCommandRecords,
  draft: DraftRef,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const record of recordsOfDraft(records.changes, draft)) {
    if (record.phase === "failed") continue;
    for (const id of record.operationIds) hidden.add(id);
  }
  for (const id of pendingChangeCommand(records.drafts, draft)?.operationIds ?? []) hidden.add(id);
  return hidden;
}

/** What a change's command record says, matched by class id or any shared operation. */
export function changeCommandState(
  records: ChangeCommandRecords,
  draft: DraftRef,
  change: ChangeRef,
): ChangeCommandState | null {
  const pending = pendingChangeCommand(records.drafts, draft);
  if (
    pending &&
    (pending.classId === change.classId ||
      pending.operationIds.some((id) => change.operationIds.includes(id)))
  ) {
    return { phase: "pending", mode: pending.mode };
  }
  const own = records.changes[recordKey(draft, change.classId)];
  const candidates = own ? [own] : recordsOfDraft(records.changes, draft);
  const ids = new Set(change.operationIds);
  for (const record of candidates) {
    if (record.phase !== "failed") continue;
    if (record !== own && !record.operationIds.some((id) => ids.has(id))) continue;
    return { phase: "failed", mode: record.mode, code: record.code };
  }
  return null;
}

export function resetChangeCommandRecords(): void {
  useChangeCommandStore.setState({ records: {} });
}

onDraftCommandRecordsReset(resetChangeCommandRecords);
