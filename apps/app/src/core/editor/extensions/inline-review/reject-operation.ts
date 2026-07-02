/** Client-side draft operation rejection: journal decode, inverse reconstruction, and tracked Yjs apply. */
import {
  type JournalSnapshot,
  type PersistedUpdate,
  reconstructUndoUpdateFromSnapshot,
} from "@meridian/agent-edit";
import type { DraftJournalResponse, ReviewOperation } from "@meridian/contracts/drafts";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "../../schema";
import { HUNK_REJECT_ORIGIN } from "./DraftInlineReviewExtension";

export function operationTargetSeqs(operation: ReviewOperation): ReadonlySet<number> {
  return new Set(operation.sourceUpdateIds);
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
}): Uint8Array {
  return reconstructUndoUpdateFromSnapshot(input.snapshot, {
    docId: input.documentId,
    targetId: input.operation.operationId,
    targetSeqs: operationTargetSeqs(input.operation),
    fragmentName: PROSEMIRROR_FRAGMENT_NAME,
  }).undoUpdate;
}

export function applyRejectUpdate(input: {
  doc: Y.Doc;
  editorState: unknown;
  inverseUpdate: Uint8Array;
}): void {
  const undoManager = undoManagerFromEditorState(input.editorState);
  undoManager?.stopCapturing?.();
  Y.applyUpdate(input.doc, input.inverseUpdate, HUNK_REJECT_ORIGIN);
}

function undoManagerFromEditorState(editorState: unknown): { stopCapturing?: () => void } | null {
  const state = yUndoPluginKey.getState(
    editorState as Parameters<typeof yUndoPluginKey.getState>[0],
  );
  return (state?.undoManager as { stopCapturing?: () => void } | undefined) ?? null;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
