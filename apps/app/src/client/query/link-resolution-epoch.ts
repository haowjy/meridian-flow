import { useEffect } from "react";
import { create } from "zustand";

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
