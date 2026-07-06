/** Client-side draft operation rejection: journal decode, inverse reconstruction, and tracked Yjs apply. */
import {
  type JournalSnapshot,
  type PersistedUpdate,
  reconstructUndoUpdateFromSnapshot,
} from "@meridian/agent-edit";
import type { DraftJournalResponse, ReviewOperation } from "@meridian/contracts/drafts";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { HUNK_REJECT_ORIGIN } from "./extensions/inline-review/DraftInlineReviewExtension";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

export function operationTargetSeqs(operation: ReviewOperation): ReadonlySet<number> {
  return new Set(operation.rejectSourceUpdateIds);
}

export function operationRejectClosure(operation: ReviewOperation): string[] {
  return operation.rejectClosureOperationIds ?? [operation.operationId];
}

export function decodeDraftJournalResponse(response: DraftJournalResponse): JournalSnapshot {
  return {
    checkpoint: response.checkpoint ? base64ToBytes(response.checkpoint) : null,
    updates: response.updates.map(
      (update): PersistedUpdate => ({
        seq: update.seq,
        update: base64ToBytes(update.update),
        updateKind: update.updateKind ?? null,
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
} {
  const targetSeqs = operationTargetSeqs(input.operation);
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
}): void {
  const undoManager = undoManagerFromEditorState(input.editorState);
  undoManager?.stopCapturing?.();
  Y.applyUpdate(input.doc, input.inverseUpdate, HUNK_REJECT_ORIGIN);
  undoManager?.stopCapturing?.();
}

function undoManagerFromEditorState(editorState: unknown): { stopCapturing?: () => void } | null {
  const state = yUndoPluginKey.getState(
    editorState as Parameters<typeof yUndoPluginKey.getState>[0],
  );
  return (state?.undoManager as { stopCapturing?: () => void } | undefined) ?? null;
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
