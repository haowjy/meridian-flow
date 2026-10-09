/**
 * What the writer sees of the changes under review (server closure classes),
 * shared by every surface that shows them: the manuscript's marks and bar, the
 * change list, the stepper, the header counts, the chat strip and the Work
 * page's rows. Sits beside
 * `draft-command-record`, which is the one command authority per draft.
 *
 * - `pending`: an Apply or Discard of this selection is dispatched. It is not
 *   stored here: it is the draft's own pending claim (`beginDraftCommand`,
 *   carrying the selection's operation set), so a whole-draft command, or a
 *   command from another session, cannot be sent beside it. The changes leave
 *   every surface at once (the writer sees the result of the click).
 * - `queued`: a batch of selections (the chat strip's Apply) has been sent, and
 *   this one has not had its turn yet. Not a claim: it blocks no command and
 *   names no draft as busy. It only hides the selection from every surface at
 *   the click, so the whole batch leaves together. It is retired per
 *   selection, when that selection's own command begins (its claim takes over)
 *   or the batch ends; a refused selection returns the moment its own answer
 *   lands, whatever the files after it are doing.
 * - `failed`: the command did not land. The changes come back, showing why on
 *   their own bars and rows, and on the file whose selection it was. One
 *   failure is held per (draft, selection) and projected to every change whose
 *   operations overlap the selection. It clears on the next action on an
 *   overlapping change, and when a later preview no longer lists any of its
 *   operations.
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
  type ChangeSelection,
  currentDraftCommandRecords,
  type DraftCommandRecords,
  onDraftCommandRecordsReset,
  pendingChangeCommand,
  releaseDraftCommand,
  type ServerRefusal,
  useDraftCommandRecords,
} from "./draft-command-record";

export type { ChangeCommandMode, ChangeSelection };

type DraftRef = { projectId: string; workId: string; documentId: string; draftId: string };

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

type ChangeRecords = Readonly<Record<string, ChangeCommandRecord>>;

/** Everything that says what is happening to a draft's changes: held outcomes and the draft's own claim. */
export type ChangeCommandRecords = {
  changes: ChangeRecords;
  queued: QueuedSelections;
  drafts: DraftCommandRecords;
};

/** A selection sent in a batch that has not had its turn: hidden, not claimed. */
type QueuedSelection = { prefix: string; operationIds: readonly string[] };
type QueuedSelections = Readonly<Record<number, QueuedSelection>>;

const useChangeCommandStore = create<{
  records: ChangeRecords;
  queued: QueuedSelections;
  clock: number;
}>(() => ({ records: {}, queued: {}, clock: 0 }));

let nextQueued = 0;

/** Preview reads that started and have not settled, by the clock they started at. */
const readsInFlight = new Set<{ fence: number }>();

function draftPrefix(draft: DraftRef): string {
  return `${draft.projectId}\u0000${draft.workId}\u0000${draft.documentId}\u0000${draft.draftId}\u0000`;
}

/** A selection's identity in the record: its classes, in a fixed order. */
function recordKey(draft: DraftRef, selection: ChangeSelection): string {
  return `${draftPrefix(draft)}${[...selection.classIds].sort().join("\u0001")}`;
}

function setRecord(
  draft: DraftRef,
  selection: ChangeSelection,
  record: ((clock: number) => ChangeCommandRecord) | null,
  advance = false,
): void {
  const key = recordKey(draft, selection);
  useChangeCommandStore.setState((state) => {
    const { [key]: _prior, ...rest } = state.records;
    const clock = advance ? state.clock + 1 : state.clock;
    return { records: record ? { ...rest, [key]: record(clock) } : rest, clock };
  });
}

/** Claim the draft for one command on this selection; false when any command is in flight on the draft. */
export function beginChangeCommand(
  draft: DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
  completesDraft = false,
): boolean {
  if (
    !beginDraftCommand(draft, {
      classIds: selection.classIds,
      operationIds: selection.operationIds,
      mode,
      ...(completesDraft ? { completesDraft: true as const } : {}),
    })
  ) {
    return false;
  }
  // The claim is the next action on these changes: a failure they held is stale now.
  clearChangeFailure(draft, selection);
  return true;
}

/**
 * Hide a selection that waits for its turn in a batch (`queued`). Returns its
 * retirement, which is idempotent: call it when the selection's own command has
 * begun (the claim hides the same operations from then on) or the batch is over.
 */
export function queueChangeSelection(draft: DraftRef, selection: ChangeSelection): () => void {
  const id = nextQueued++;
  const entry = { prefix: draftPrefix(draft), operationIds: selection.operationIds };
  useChangeCommandStore.setState((state) => ({ queued: { ...state.queued, [id]: entry } }));
  return () => {
    if (!(id in useChangeCommandStore.getState().queued)) return;
    useChangeCommandStore.setState((state) => {
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
  setRecord(
    draft,
    selection,
    (at) => ({
      phase: "failed",
      mode,
      code,
      ...(refusal ? { serverCode: refusal.serverCode } : {}),
      ...(refusal?.serverReason ? { serverReason: refusal.serverReason } : {}),
      at,
      classIds: selection.classIds,
      operationIds: selection.operationIds,
    }),
    true,
  );
}

export function confirmChangeCommand(
  draft: DraftRef,
  selection: ChangeSelection,
  mode: ChangeCommandMode,
): void {
  setRecord(
    draft,
    selection,
    (at) => ({
      phase: "confirmed",
      mode,
      at,
      classIds: selection.classIds,
      operationIds: selection.operationIds,
    }),
    true,
  );
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

/**
 * The failures held for this selection: under one of its class ids, or under
 * any selection that shares one of its operations (the server regrouped it
 * since). The one rule for finding a change's or a file's failure, to show it
 * and to retire it.
 */
function failuresOfSelection(
  records: ChangeRecords,
  draft: DraftRef,
  selection: ChangeSelection,
): { key: string; record: FailedRecord }[] {
  const prefix = draftPrefix(draft);
  const held: { key: string; record: FailedRecord }[] = [];
  for (const [key, record] of Object.entries(records)) {
    if (record.phase === "failed" && key.startsWith(prefix) && overlaps(record, selection)) {
      held.push({ key, record });
    }
  }
  return held;
}

/** Drop the failures held for a selection (the next action on it, a dismissal); never touches a claim. */
export function clearChangeFailure(draft: DraftRef, selection: ChangeSelection): void {
  const held = failuresOfSelection(useChangeCommandStore.getState().records, draft, selection);
  if (held.length === 0) return;
  const dropped = new Set(held.map(({ key }) => key));
  useChangeCommandStore.setState((state) => ({
    records: Object.fromEntries(Object.entries(state.records).filter(([key]) => !dropped.has(key))),
  }));
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
  const queued = useChangeCommandStore((state) => state.queued);
  const drafts = useDraftCommandRecords();
  return useMemo(() => ({ changes, queued, drafts }), [changes, queued, drafts]);
}

/** The records right now, for code that is not a render (commands, tests). */
export function currentChangeCommandRecords(): ChangeCommandRecords {
  return {
    changes: useChangeCommandStore.getState().records,
    queued: useChangeCommandStore.getState().queued,
    drafts: currentDraftCommandRecords(),
  };
}

function recordsOfDraft(records: ChangeRecords, draft: DraftRef): ChangeCommandRecord[] {
  const prefix = draftPrefix(draft);
  return Object.entries(records)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, record]) => record);
}

/** The operations hidden from this draft's preview: every change queued, pending or confirmed. */
export function hiddenOperationIds(
  records: ChangeCommandRecords,
  draft: DraftRef,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const record of recordsOfDraft(records.changes, draft)) {
    if (record.phase === "failed") continue;
    for (const id of record.operationIds) hidden.add(id);
  }
  const prefix = draftPrefix(draft);
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
  const latest = failuresOfSelection(records.changes, draft, selection).reduce<FailedRecord | null>(
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

export function resetChangeCommandRecords(): void {
  useChangeCommandStore.setState({ records: {}, queued: {} });
}

onDraftCommandRecordsReset(resetChangeCommandRecords);
