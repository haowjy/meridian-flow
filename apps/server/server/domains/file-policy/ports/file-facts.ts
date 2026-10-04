/** Port: load the facts the file policy decides on (file-access §2, §5). */
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { FileFacts, FileTarget, SkillFacts } from "../domain/types.js";

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
   * The list path (file-access §6): many documents' facts in one query, each
   * through `draftWorkId`'s draft when given. Folders are left out of
   * `ancestors` and `path`: a listed row is already visible, and v1 grants
   * sit on the project. Missing documents are absent from the map.
   */
  loadList(
    documentIds: readonly DocumentId[],
    draftWorkId?: WorkId,
  ): Promise<Map<DocumentId, FileFacts>>;
  /**
   * Inside the ambient transaction: lock every named Work that owns a target
   * or its draft `FOR NO KEY UPDATE`, sorted by id, then read the facts under
   * those locks. A file whose owner moved between the first read and the lock
   * reads as not found, since locking the new owner would break the id order.
   */
  loadLocked(requests: readonly FileFactsRequest[]): Promise<(FileFacts | null)[]>;
  /** The skills a thread's own binding names (D52); `skillLevel` decides which it may read. */
  skillFacts(threadId: ThreadId): Promise<SkillFacts>;
}
