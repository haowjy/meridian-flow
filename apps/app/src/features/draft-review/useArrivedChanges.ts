/**
 * useArrivedChanges — which changes arrived while the writer was reviewing.
 *
 * The first read of a draft is the baseline: everything in it was already
 * there. The runtime marks new AI writes with an arrival sequence,
 * and is reported for a moment so its row and marks can pulse once. The
 * writer's own typing is never an arrival.
 */
import { useEffect, useRef, useState } from "react";

import type { ReviewChange } from "./review-model";

const PULSE_MS = 1400;

export function useArrivedChanges(
  changes: readonly ReviewChange[],
  ready: boolean,
  draftKey: string | null,
): ReadonlySet<string> {
  const known = useRef<{ key: string | null; sequence: number } | null>(null);
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
      known.current = {
        key: draftKey,
        sequence: changes.reduce((last, change) => Math.max(last, change.arrival ?? 0), 0),
      };
      setArrived(EMPTY);
      return;
    }
    const seen = known.current.sequence;
    const fresh = changes.filter((change) => change.arrival !== undefined && change.arrival > seen);
    for (const change of fresh)
      known.current.sequence = Math.max(known.current.sequence, change.arrival ?? 0);
    if (fresh.length === 0) return;
    setArrived((current) => new Set([...current, ...fresh.map((change) => change.id)]));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setArrived((current) => {
        const next = new Set(current);
        for (const change of fresh) next.delete(change.id);
        return next.size === current.size ? current : next;
      });
    }, PULSE_MS);
    timers.current.add(timer);
  }, [changes, ready, draftKey]);

  return arrived;
}

const EMPTY: ReadonlySet<string> = new Set();
