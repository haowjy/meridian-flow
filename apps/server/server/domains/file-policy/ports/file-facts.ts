/** Port: load the facts the file policy decides on (file-access §2, §5). */
import type { WorkId } from "@meridian/contracts/runtime";
import type { FileFacts, FileTarget } from "../domain/types.js";

export interface FileFactsRequest {
  target: FileTarget;
  /**
   * The Work whose draft this access may go through: an agent's draft-mode
   * Work. A `draft` target names its own; facts then include `draftWork`.
   */
  draftWorkId?: WorkId;
}

export interface FileFactsPort {
  /** Unlocked read; null when the target doesn't exist. */
  load(request: FileFactsRequest): Promise<FileFacts | null>;
  /**
   * Inside the ambient transaction: lock every named Work that owns a target
   * or its draft `FOR NO KEY UPDATE`, sorted by id, then read the facts under
   * those locks. An owner that changes after locking is locked and read once
   * more; one that changes again reads as not found.
   */
  loadLocked(requests: readonly FileFactsRequest[]): Promise<(FileFacts | null)[]>;
}
