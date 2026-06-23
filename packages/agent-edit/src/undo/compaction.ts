// Compact-on-load entry point; adapters own the journal mutation, live docs are untouched.
import type { CompactionResult, PersistedUpdate } from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";

export interface CompactOnLoadOptions {
  docId: string;
  /**
   * Effective compaction cutoff: folds updates older than this date. The public
   * core facade clamps this to the reversal retention horizon when retention is
   * configured; callers using this helper directly own cutoff safety.
   */
  before: Date;
}

export interface CompactOnLoadResult extends CompactionResult {
  checkpoint: Uint8Array | null;
  retainedUpdates: PersistedUpdate[];
}

export async function compactOnLoad(
  journal: UpdateJournal,
  options: CompactOnLoadOptions,
): Promise<CompactOnLoadResult> {
  const result = await journal.compact(options.docId, options.before);
  const snapshot = await journal.read(options.docId);
  return {
    ...result,
    checkpoint: snapshot.checkpoint,
    retainedUpdates: snapshot.updates,
  };
}
