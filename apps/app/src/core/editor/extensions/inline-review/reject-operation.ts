/** Client-side draft operation rejection: journal decode, inverse reconstruction, and tracked Yjs apply. */
import {
  type JournalSnapshot,
  type PersistedUpdate,
  reconstructUndoUpdateFromSnapshot,
} from "@meridian/agent-edit";
import type { DraftJournalResponse, ReviewOperation } from "@meridian/contracts/drafts";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "../../schema";
import { HUNK_REJECT_ORIGIN } from "./DraftInlineReviewExtension";

export function operationTargetSeqs(operation: ReviewOperation): ReadonlySet<number> {
  return new Set(operation.rejectSourceUpdateIds);
}

export function operationRejectIsMixed(operation: ReviewOperation): boolean {
  if (operation.rejectSourceUpdateIds.length === operation.sourceUpdateIds.length) {
    const source = new Set(operation.sourceUpdateIds);
    return operation.rejectSourceUpdateIds.some((seq) => !source.has(seq));
  }
  return true;
}

export function decodeDraftJournalResponse(response: DraftJournalResponse): JournalSnapshot {
  return {
    checkpoint: response.checkpoint ? base64ToBytes(response.checkpoint) : null,
    updates: response.updates.map(
      (update): PersistedUpdate => ({
        seq: update.seq,
        update: base64ToBytes(update.update),
        meta: { origin: "system", seq: update.seq },
      }),
    ),
  };
}

export function reconstructOperationRejectUpdate(input: {
  snapshot: JournalSnapshot;
  operation: ReviewOperation;
  documentId: string;
}): {
  inverseUpdate: Uint8Array;
  journalEndStateVector: Uint8Array;
  desiredState?: Uint8Array;
  desiredContent?: unknown;
} {
  const targetSeqs = operationTargetSeqs(input.operation);
  if (operationRejectIsMixed(input.operation)) {
    return reconstructTargetlessReplacementUpdate(input.snapshot, targetSeqs);
  }
  const result = reconstructUndoUpdateFromSnapshot(input.snapshot, {
    docId: input.documentId,
    targetId: input.operation.operationId,
    targetSeqs,
    fragmentName: PROSEMIRROR_FRAGMENT_NAME,
  });
  return { inverseUpdate: result.undoUpdate, journalEndStateVector: result.endStateVector };
}

export function applyRejectUpdate(input: {
  doc: Y.Doc;
  editor: Editor;
  editorState: unknown;
  inverseUpdate: Uint8Array;
  desiredState?: Uint8Array;
  desiredContent?: unknown;
}): void {
  const undoManager = undoManagerFromEditorState(input.editorState);
  undoManager?.stopCapturing?.();
  if (input.desiredContent) {
    input.editor.commands.setContent(
      input.desiredContent as Parameters<typeof input.editor.commands.setContent>[0],
    );
  } else {
    Y.applyUpdate(input.doc, input.inverseUpdate, HUNK_REJECT_ORIGIN);
  }
  undoManager?.stopCapturing?.();
}

function undoManagerFromEditorState(editorState: unknown): { stopCapturing?: () => void } | null {
  const state = yUndoPluginKey.getState(
    editorState as Parameters<typeof yUndoPluginKey.getState>[0],
  );
  return (state?.undoManager as { stopCapturing?: () => void } | undefined) ?? null;
}

function reconstructTargetlessReplacementUpdate(
  snapshot: JournalSnapshot,
  targetSeqs: ReadonlySet<number>,
): {
  inverseUpdate: Uint8Array;
  journalEndStateVector: Uint8Array;
  desiredState: Uint8Array;
  desiredContent: unknown;
} {
  const currentDoc = replayJournal(snapshot, () => true);
  const journalEndStateVector = Y.encodeStateVector(currentDoc);
  const desiredDoc = replayJournal(snapshot, (update) => !targetSeqs.has(update.seq));
  return {
    inverseUpdate: new Uint8Array(),
    journalEndStateVector,
    desiredState: Y.encodeStateAsUpdate(desiredDoc),
    desiredContent: yXmlFragmentToProsemirrorJSON(
      desiredDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    ),
  };
}

function replayJournal(
  snapshot: JournalSnapshot,
  includeUpdate: (update: PersistedUpdate) => boolean,
): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
  for (const update of snapshot.updates) {
    if (includeUpdate(update)) Y.applyUpdate(doc, update.update);
  }
  return doc;
}

export function stateVectorsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
