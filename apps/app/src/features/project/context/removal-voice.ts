/** Who removed a document, as the Trash row names them: the same for the current account and anyone else. */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";

/**
 * A user with no display name, a purged actor, or no record read as anonymous.
 */
export type RemovalVoice =
  | { kind: "person"; name: string; reason: DocumentRemovalRecord["reason"] }
  /** The model of a chat deleted it; null `chat` when that chat has no title. */
  | { kind: "agent"; chat: string | null }
  | { kind: "anonymous"; reason: DocumentRemovalRecord["reason"] };

/** A chat's title by its id, null when it has none (`useCachedChatTitles`). */
export type ChatTitles = (chatId: string) => string | null;

/**
 * A chat's AI is named by its chat: the record's title when the server sent one, else the chat
 * list's title for the chat the record names.
 */
export function removalVoice(
  record: DocumentRemovalRecord | null,
  chats: ChatTitles,
): RemovalVoice {
  const reason = record?.reason ?? "deleted";
  const actor = record?.actor;
  if (actor?.kind === "user" && actor.displayName)
    return { kind: "person", name: actor.displayName, reason };
  if (actor?.kind === "agent")
    return {
      kind: "agent",
      chat: actor.chatTitle ?? (actor.chatId ? chats(actor.chatId) : null),
    };
  return { kind: "anonymous", reason };
}
