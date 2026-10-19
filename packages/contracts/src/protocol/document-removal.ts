/** The current removal of a document identity, not a history of its removals. */
import type { UserId } from "../ids.js";

export type DocumentRemovalCause = "reply_rolled_back" | "create_failed" | "repair";
/** A create's own retraction: the reply that made it rolled back, or the create failed. */
export type RetractionCause = Exclude<DocumentRemovalCause, "repair">;

type DocumentRemovalActor =
  | { kind: "user"; userId: UserId; displayName: string | null }
  | { kind: "work"; name: string }
  | { kind: "system"; cause: DocumentRemovalCause };

export type DocumentRemovalRecord = {
  reason: "deleted" | "discarded";
  /** Unknown when the actor's account or Work was purged. */
  actor: DocumentRemovalActor | null;
  time: string;
};
