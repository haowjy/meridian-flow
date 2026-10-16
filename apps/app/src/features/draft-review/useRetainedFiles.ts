/**
 * The one owner of "a file the server stopped listing, shown a little longer": a row stays on a surface
 * while something names it (a live Undo, a failure, an overwrite notice) and goes the moment the last
 * reason ends. The surface lists the current rows and decides the reasons and how a kept row is drawn;
 * this keeps only the rows with a reason, so it is bounded by what the writer can still act on, not by every
 * draft the surface has ever listed. A new `scope` (another Work) starts empty.
 */
import { useRef } from "react";

type Held<T> = {
  scope: string;
  /** The previous render's rows, so a row that just left the list can still be kept by a reason named now. */
  last: Map<string, T>;
  kept: Map<string, T>;
  result: readonly T[];
};

const NONE: readonly never[] = [];

/** The rows no longer in `current` that `holds` still names, keyed by `keyOf`. The array is stable while its rows are. */
export function useRetainedFiles<T>(
  scope: string,
  current: readonly T[],
  keyOf: (row: T) => string,
  holds: (row: T) => boolean,
): readonly T[] {
  const ref = useRef<Held<T>>({ scope, last: new Map(), kept: new Map(), result: NONE });
  if (ref.current.scope !== scope)
    ref.current = { scope, last: new Map(), kept: new Map(), result: NONE };
  const held = ref.current;

  const listed = new Map(current.map((row) => [keyOf(row), row]));
  const kept = new Map<string, T>();
  for (const candidates of [held.kept, held.last]) {
    for (const [key, row] of candidates) {
      if (!listed.has(key) && !kept.has(key) && holds(row)) kept.set(key, row);
    }
  }
  held.last = listed;
  held.kept = kept;
  const rows = [...kept.values()];
  if (rows.length !== held.result.length || rows.some((row, i) => row !== held.result[i]))
    held.result = rows;
  return held.result;
}
