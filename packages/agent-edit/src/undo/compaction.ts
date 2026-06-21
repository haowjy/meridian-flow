// Compact-on-load entry point; adapters own the journal mutation, live docs are untouched.
import type { CompactionResult, PersistedUpdate } from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import type { UndoManagerRegistry } from "./manager-registry.js";

export interface CompactOnLoadOptions {
  docId: string;
  before: Date;
  /** Optional hot registry guard; compaction is only legal before live UMs exist. */
  registry?: Pick<UndoManagerRegistry, "hasActiveDocument">;
}

export interface CompactOnLoadResult extends CompactionResult {
  checkpoint: Uint8Array | null;
  retainedUpdates: PersistedUpdate[];
}

export async function compactOnLoad(
  journal: UpdateJournal,
  options: CompactOnLoadOptions,
): Promise<CompactOnLoadResult> {
  if (options.registry?.hasActiveDocument(options.docId)) {
    throw new Error(`Cannot compact ${options.docId} while live UndoManagers are active`);
  }
  const result = await journal.compact(options.docId, options.before);
  const snapshot = await journal.read(options.docId);
  return {
    ...result,
    checkpoint: snapshot.checkpoint,
    retainedUpdates: snapshot.updates,
  };
}
