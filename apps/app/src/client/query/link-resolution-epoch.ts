/**
 * link-resolution-epoch — a per-project counter that says server link answers may be old.
 *
 * Some answers name targets outside the catalogs a surface loads: hidden draft
 * documents and another Work's Scratch folders, for example. Catalog wake hints
 * bump this epoch so those answers are asked again. Focus and network return are
 * the fallback when a page missed the live hint.
 */
import { useEffect } from "react";
import { create } from "zustand";

/** How long an answer is trusted before returning to the window asks again, as the draft lists do. */
const STALE_MS = 15_000;

const useLinkResolutionEpochStore = create<{ epochs: Record<string, number> }>(() => ({
  epochs: {},
}));
const bumpedAt = new Map<string, number>();

export function bumpLinkResolutionEpoch(projectId: string): void {
  bumpedAt.set(projectId, Date.now());
  useLinkResolutionEpochStore.setState((state) => ({
    epochs: { ...state.epochs, [projectId]: (state.epochs[projectId] ?? 0) + 1 },
  }));
}

export function useLinkResolutionEpoch(projectId: string | null): number {
  useEffect(() => {
    if (!projectId) return;
    const refresh = () => {
      if (Date.now() - (bumpedAt.get(projectId) ?? 0) >= STALE_MS)
        bumpLinkResolutionEpoch(projectId);
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
  return useLinkResolutionEpochStore((state) => (projectId ? (state.epochs[projectId] ?? 0) : 0));
}
