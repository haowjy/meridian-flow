/**
 * ephemeral-undo-store — the single, session-local home for the "just applied,
 * Undo?" chip.
 *
 * After an Apply/accept from the dock or the editor bar, the latest turn line
 * flashes an `Undo` chip. It is deliberately ephemeral: ANY navigation (thread
 * switch, document/tab switch, route change — not scrolling) dismisses it, and
 * it is never persisted. Exactly one entry exists at a time; a newer apply
 * replaces the older one.
 *
 * This lives OUTSIDE React (a tiny Zustand store) because the surface that
 * SETS it (dock / editor bar) and the surface that RENDERS it (the turn line)
 * are in different subtrees; a shared store keeps them from having to thread
 * the marker through props they otherwise don't share.
 */
import { create } from "zustand";

export type EphemeralUndoEntry = {
  /** Thread whose latest turn line hosts the chip. */
  threadId: string;
  projectId: string;
  workId: string;
  documentId: string;
  draftId: string;
  /** Document display name, for the chip's accessible label. */
  documentName: string | null;
};

type EphemeralUndoState = {
  entry: EphemeralUndoEntry | null;
  mark: (entry: EphemeralUndoEntry) => void;
  clear: () => void;
};

export const useEphemeralUndoStore = create<EphemeralUndoState>((set) => ({
  entry: null,
  mark: (entry) => set({ entry }),
  clear: () => set({ entry: null }),
}));
