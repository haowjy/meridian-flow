/**
 * draft-link-epoch — a per-project counter that says link answers about hidden documents may be old.
 *
 * A link's "In a draft" answer comes from the server about hidden documents, which no
 * catalog lists, so discarding or applying a draft changes the truth without changing the catalog
 * revision. The link index folds this epoch into its revision so those answers are asked again.
 * It bumps when a draft command settles on this device, and when the writer comes back to the
 * window or the network returns, which is how a Discard made on another device is caught up.
 */
import { useEffect } from "react";
import { create } from "zustand";

/** How long an answer is trusted before returning to the window asks again, as the draft lists do. */
const STALE_MS = 15_000;

const useDraftLinkEpochStore = create<{ epochs: Record<string, number> }>(() => ({ epochs: {} }));
const bumpedAt = new Map<string, number>();

export function bumpDraftLinkEpoch(projectId: string): void {
  bumpedAt.set(projectId, Date.now());
  useDraftLinkEpochStore.setState((state) => ({
    epochs: { ...state.epochs, [projectId]: (state.epochs[projectId] ?? 0) + 1 },
  }));
}

export function useDraftLinkEpoch(projectId: string | null): number {
  useEffect(() => {
    if (!projectId) return;
    const refresh = () => {
      if (Date.now() - (bumpedAt.get(projectId) ?? 0) >= STALE_MS) bumpDraftLinkEpoch(projectId);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId]);
  return useDraftLinkEpochStore((state) => (projectId ? (state.epochs[projectId] ?? 0) : 0));
}
