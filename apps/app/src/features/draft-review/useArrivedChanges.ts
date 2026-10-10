/**
 * useArrivedChanges — which changes arrived while the writer was reviewing.
 *
 * The first read of a draft is the baseline: everything in it was already
 * there. A change that shows up later is an arrival (the AI is still writing),
 * and is reported for a moment so its row and marks can pulse once. The
 * writer's own typing is never an arrival.
 */
import { useEffect, useRef, useState } from "react";

import type { ReviewChange } from "./review-changes";

const PULSE_MS = 1400;

export function useArrivedChanges(
  changes: readonly ReviewChange[],
  ready: boolean,
  draftKey: string | null,
): ReadonlySet<string> {
  const known = useRef<{ key: string | null; ids: Set<string> } | null>(null);
  const [arrived, setArrived] = useState<ReadonlySet<string>>(EMPTY);
  // Timers outlive the effect that set them: a refetch re-runs it, and the
  // pulse of an earlier arrival must still end on time.
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const held = timers.current;
    return () => {
      for (const timer of held) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!ready || !draftKey) {
      known.current = null;
      return;
    }
    if (known.current?.key !== draftKey) {
      known.current = { key: draftKey, ids: new Set(changes.map((change) => change.classId)) };
      setArrived(EMPTY);
      return;
    }
    const seen = known.current.ids;
    const fresh = changes.filter((change) => !seen.has(change.classId) && change.tone !== "writer");
    for (const change of changes) seen.add(change.classId);
    if (fresh.length === 0) return;
    setArrived((current) => new Set([...current, ...fresh.map((change) => change.classId)]));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setArrived((current) => {
        const next = new Set(current);
        for (const change of fresh) next.delete(change.classId);
        return next.size === current.size ? current : next;
      });
    }, PULSE_MS);
    timers.current.add(timer);
  }, [changes, ready, draftKey]);

  return arrived;
}

const EMPTY: ReadonlySet<string> = new Set();
