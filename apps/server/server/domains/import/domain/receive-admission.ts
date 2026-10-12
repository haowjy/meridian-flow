/** Per-process bound on concurrent multipart receives for one import. */
import { IMPORT_LIMITS } from "./manifest.js";

export interface ImportAdmission {
  /** A release callback, or null when the import already has its limit in flight. */
  enter(importId: string): (() => void) | null;
}

export function createImportAdmission(
  limit: number = IMPORT_LIMITS.receivesPerImport,
): ImportAdmission {
  const active = new Map<string, number>();
  return {
    enter(importId) {
      const count = active.get(importId) ?? 0;
      if (count >= limit) return null;
      active.set(importId, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (active.get(importId) ?? 1) - 1;
        if (left) active.set(importId, left);
        else active.delete(importId);
      };
    },
  };
}

/** Run at most `limit` tasks at once, preserving input order in the results. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]);
      }
    }),
  );
  return results;
}
