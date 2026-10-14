/** Hooks that read one import's store and keep it watched while a surface is on screen. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ImportDisplayState } from "./display-state";
import { useImports } from "./ImportProvider";
import type { ImportState } from "./import-state";
import { effectiveCounts } from "./import-state";
import type { ImportStore } from "./import-store";
import { displayOf, type Watch } from "./import-store";

export function useImportStore(importId: string): ImportStore {
  const { coordinator } = useImports();
  return coordinator.store(importId);
}

export type ImportView = {
  store: ImportStore;
  state: ImportState;
  display: ImportDisplayState;
  counts: ReturnType<typeof effectiveCounts>;
};

/**
 * One import's state, its display state and its counts. `watch` keeps the
 * store polling while this surface is mounted.
 */
export function useImport(importId: string, watch: Watch): ImportView {
  const store = useImportStore(importId);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.watch(watch), [store, watch]);
  // Paused and importing-elsewhere depend on the clock; look again while it matters.
  const [tick, setTick] = useState(0);
  const display = useMemo(() => displayOf(state), [state, tick]);
  useEffect(() => {
    if (display !== "importing-elsewhere" && display !== "importing") return;
    const timer = setInterval(() => setTick((value) => value + 1), 5000);
    return () => clearInterval(timer);
  }, [display]);
  return { store, state, display, counts: effectiveCounts(state) };
}
