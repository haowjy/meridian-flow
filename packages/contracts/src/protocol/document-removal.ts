/** The current removal of a document identity, not a history of its removals. */
import type { UserId } from "../ids.js";

type DocumentRemovalActor =
  | { kind: "user"; userId: UserId; displayName: string | null }
  /** A chat's model deleted it; null `chatTitle` when the chat has none yet. */
  | { kind: "agent"; chatTitle: string | null };

export type DocumentRemovalRecord = {
  reason: "deleted" | "discarded";
  /** Unknown when the actor's account or chat was purged. */
  actor: DocumentRemovalActor | null;
  time: string;
};
