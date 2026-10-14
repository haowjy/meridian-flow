/** One import as the coordinator shows it, for a surface that is on screen. */
import { useEffect, useMemo, useState } from "react";
import type { ImportDisplayState } from "./display-state";
import { useImports, useImportsSnapshot } from "./ImportProvider";
import type { ImportState } from "./import-state";
import { displayOf } from "./import-store";

export type ImportView = { state: ImportState; display: ImportDisplayState };

/** The import's state and display state, or null once the coordinator has retired it. */
export function useImport(importId: string): ImportView | null {
  const { coordinator } = useImports();
  const tracked = useImportsSnapshot(coordinator).imports.find(
    (item) => item.importId === importId,
  );
  const state = tracked?.state ?? null;
  // Paused and importing-elsewhere depend on the clock; look again while it matters.
  const [tick, setTick] = useState(0);
  const display = useMemo(() => (state ? displayOf(state) : null), [state, tick]);
  useEffect(() => {
    if (display !== "importing-elsewhere" && display !== "importing") return;
    const timer = setInterval(() => setTick((value) => value + 1), 5000);
    return () => clearInterval(timer);
  }, [display]);
  return state && display ? { state, display } : null;
}
