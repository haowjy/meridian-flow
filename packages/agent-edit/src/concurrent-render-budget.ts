// Applies an aggregate request budget to indivisible concurrent-edit runs.

import type { ConcurrentEditInfo, ConcurrentEditRun } from "./apply/types.js";

export interface ConcurrentRenderBudget {
  remainingBytes: number;
}

export function applyConcurrentRenderBudget(
  info: ConcurrentEditInfo,
  budget: ConcurrentRenderBudget,
): ConcurrentEditInfo {
  const runs: ConcurrentEditRun[] = [];
  let overflow = false;
  for (const run of info.runs) {
    const bytes = renderedRunBytes(run);
    if (bytes > budget.remainingBytes) {
      overflow = true;
      continue;
    }
    budget.remainingBytes -= bytes;
    runs.push(run);
  }
  return {
    ...info,
    runs,
    ...(overflow ? { syncOverflow: true } : {}),
  };
}

export function renderedRunBytes(run: ConcurrentEditRun): number {
  const text = [
    run.origin,
    ...run.blocks,
    ...run.tombstones.flatMap((item) => [item.hash, "[explicit deletion]", item.capturedBody]),
  ].join("\n");
  return new TextEncoder().encode(text).byteLength;
}
