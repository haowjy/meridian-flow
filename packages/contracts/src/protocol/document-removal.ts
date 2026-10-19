/** The current removal of a document identity, not a history of its removals. */
import type { UserId, WorkId } from "../ids.js";

export type DocumentRemovalCause = "reply_rolled_back" | "create_failed" | "repair";

export type DocumentRemovalActor =
  | { kind: "user"; userId: UserId; displayName: string | null }
  | { kind: "work"; workId: WorkId; name: string }
  | { kind: "system"; cause: DocumentRemovalCause };

export type DocumentRemovalRecord = {
  reason: "deleted" | "discarded";
  /** Unknown for legacy removals or an actor whose account/Work was purged. */
  actor: DocumentRemovalActor | null;
  time: string;
};
