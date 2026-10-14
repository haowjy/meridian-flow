/**
 * What an accepted import is doing, as the mark on its operation target shows it:
 * sending, stopping, interrupted or failed, with the counts its sentence and its
 * Stop dialog need. A pure function of the import's state; the tree projection
 * places it and the mark's menu offers the commands each kind allows.
 */

import { effectiveCounts, type ImportState } from "./import-state";
import { displayOf } from "./import-store";
import type { ImportRunInfo } from "./tree-rows";

export function runInfoOf(
  importId: string,
  state: ImportState,
  now = Date.now(),
): ImportRunInfo | null {
  const counts = effectiveCounts(state);
  if (!counts) return null;
  const kind = kindOf(displayOf(state, now));
  if (!kind) return null;
  return {
    importId,
    kind,
    arrived: Math.max(0, counts.total - counts.arriving - counts.failed),
    total: counts.total,
    failed: counts.failed,
    remaining: counts.arriving + counts.failed,
    canRetry: state.local?.held != null,
  };
}

function kindOf(display: ReturnType<typeof displayOf>): ImportRunInfo["kind"] | null {
  switch (display) {
    case "importing":
    case "importing-elsewhere":
      return "sending";
    case "stopping":
      return "stopping";
    // A stop that failed leaves the import as unfinished as one nobody is sending.
    case "paused":
    case "couldnt-stop":
      return "interrupted";
    case "needs-attention":
      return "failed";
    default:
      return null;
  }
}
