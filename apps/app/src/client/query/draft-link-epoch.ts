/**
 * draft-link-epoch — a per-project counter bumped when a draft command settles.
 *
 * A link's "In a draft" answer comes from the server about hidden documents, which no
 * catalog lists, so discarding the draft changes the truth without changing the catalog
 * revision. The link index folds this epoch into its revision so those answers are asked again.
 */
import { create } from "zustand";

const useDraftLinkEpochStore = create<{ epochs: Record<string, number> }>(() => ({ epochs: {} }));

export function bumpDraftLinkEpoch(projectId: string): void {
  useDraftLinkEpochStore.setState((state) => ({
    epochs: { ...state.epochs, [projectId]: (state.epochs[projectId] ?? 0) + 1 },
  }));
}

export function useDraftLinkEpoch(projectId: string | null): number {
  return useDraftLinkEpochStore((state) => (projectId ? (state.epochs[projectId] ?? 0) : 0));
}
