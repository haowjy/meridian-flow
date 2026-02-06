import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useThreadStore } from "@/core/stores/useThreadStore";
import { makeLogger } from "@/core/lib/logger";

const log = makeLogger("useTurnsForThread");

/**
 * Feature-level hook for loading turns for a given thread.
 *
 * For now this wraps useThreadStore.loadTurns(threadId, signal) and exposes
 * a turn-view slice + loading state. Later it will operate directly on
 * the richer Turn model (with blocks/metadata).
 */
export function useTurnsForThread(threadId: string | null) {
  const { turnIds, isLoadingTurns, error, loadTurns, storeThreadId } =
    useThreadStore(
      useShallow((s) => ({
        turnIds: s.turnIds,
        isLoadingTurns: s.isLoadingTurns,
        error: s.error,
        loadTurns: s.loadTurns,
        storeThreadId: s.threadId,
      })),
    );

  const abortRef = useRef<AbortController | null>(null);
  // Keep a ref to loadTurns to avoid stale closures
  const loadTurnsRef = useRef(loadTurns);

  // Update the ref when loadTurns changes
  useEffect(() => {
    loadTurnsRef.current = loadTurns;
  }, [loadTurns]);

  // NOTE: This hook has custom abort logic (skip if already loaded) so we don't use
  // useAbortableEffect here. The pattern is preserved intentionally.
  useEffect(() => {
    if (!threadId) return;

    log.debug("effect:start", { threadId });

    // If we already have turns for this thread (or a load is already in-flight),
    // don't re-fetch on remount / tab switches. This prevents "progressive reload"
    // when navigating away and back.
    const state = useThreadStore.getState();
    if (
      state.threadId === threadId &&
      (state.turnIds.length > 0 || state.isLoadingTurns)
    ) {
      log.debug("effect:skip", {
        threadId,
        turns: state.turnIds.length,
        isLoadingTurns: state.isLoadingTurns,
      });
      return;
    }

    // Cancel any in-flight request before starting a new one
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // Use the ref to call loadTurns, avoiding stale closures
    void loadTurnsRef.current(threadId, controller.signal);

    return () => {
      controller.abort();
      log.debug("effect:cleanup", { threadId });
    };
  }, [threadId]);

  useEffect(() => {
    log.debug("state:update", {
      threadId,
      turns: turnIds.length,
      isLoadingTurns,
      error,
    });
  }, [threadId, turnIds.length, isLoadingTurns, error]);

  // Prevent showing stale data during thread transitions.
  const scopedIds = threadId && storeThreadId === threadId ? turnIds : [];

  return {
    turnIds: scopedIds,
    isLoading: isLoadingTurns,
    error,
  };
}
