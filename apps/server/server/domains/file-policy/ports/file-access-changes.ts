/**
 * Port: tells every server instance that some files' access changed, so live
 * rooms admitted at the old level reconnect at the new one (file-access §7).
 */
import type { WorkId } from "@meridian/contracts/runtime";

/** Archive, unarchive, delete or restore of a Work: its own files (drafts, scratch). */
export type FileAccessChange = { workId: WorkId };

export interface FileAccessChanges {
  /**
   * Inside a transaction, every instance hears it only once that commits;
   * a rolled-back change is never heard.
   */
  publish(change: FileAccessChange): Promise<void>;
  /** Hears changes on this instance; returns the unsubscribe. */
  subscribe(listener: (change: FileAccessChange) => void): () => void;
}
