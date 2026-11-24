import type { UserId } from "../ids.js";

type DocumentRemovalActor =
  | { kind: "user"; userId: UserId; displayName: string | null }
  | { kind: "agent"; chatTitle: string | null; chatId?: string };

export type DocumentRemovalRecord = {
  reason: "deleted" | "discarded";
  actor: DocumentRemovalActor | null;
  time: string;
};
