/**
 * Port: tells every server instance that some files' access changed, so live
 * rooms admitted at the old level reconnect at the new one (file-access §7).
 */
import type { WorkId } from "@meridian/contracts/runtime";

/**
 * Archive, unarchive, delete or restore of a Work: its own files (drafts, scratch). Or a
 * lineage gaining or losing its last live chat: its drafts freeze and thaw.
 */
export type FileAccessChange = { workId: WorkId } | { rootThreadId: string };

/** The key a room registers under for this change: a Work id, or `lineage:<root>`. */
export function fileAccessChangeKey(change: FileAccessChange): string {
  return "workId" in change ? change.workId : `lineage:${change.rootThreadId}`;
}

export interface FileAccessChanges {
  /**
   * Inside a transaction, every instance hears it only once that commits;
   * a rolled-back change is never heard.
   */
  publish(change: FileAccessChange): Promise<void>;
  /** Hears changes on this instance; returns the unsubscribe. */
  subscribe(listener: (change: FileAccessChange) => void): () => void;
}
