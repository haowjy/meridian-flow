/**
 * Each chat's agent as one more peer in the room it last wrote in: a caret labelled with the
 * agent's name, at the end of its latest write, published through the presence relay. It shows
 * while the chat's run is awake, and after the run for as long as the prompt cache of its last
 * model request stays warm (`cacheColdAt`, the rule the cache prediction applies); then it goes.
 * Lifecycle: `.context/state-machines.md`, "An agent's caret".
 */
import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import { type DocCursor, encodePoint } from "@meridian/loro-prosemirror";
import type { PresenceRelay } from "./loro-presence.js";

type Chat = {
  agentName: string | null;
  /**
   * When the cache of the chat's last request goes cold; null when the model names no lifetime.
   * A chat whose run is awake has no expiry, whatever this says.
   */
  warmUntil: number | null;
  /** The room the caret is in and its entry there. */
  caret: { roomId: string; cursor: DocCursor } | null;
  expiry: ReturnType<typeof setTimeout> | null;
};

export type AgentPresence = ReturnType<typeof createAgentPresence>;

export function createAgentPresence(relay: Pick<PresenceRelay, "publish">) {
  const chats = new Map<string, Chat>();
  const keyOf = (threadId: string) => `agent:${threadId}`;

  const show = (threadId: string, chat: Chat) => {
    if (!chat.caret) return;
    const point = encodePoint(chat.caret.cursor);
    relay.publish(chat.caret.roomId, keyOf(threadId), {
      user: { name: chat.agentName, agent: true },
      cursor: { anchor: point, head: point },
    });
  };

  const forget = (threadId: string) => {
    const chat = chats.get(threadId);
    if (!chat) return;
    if (chat.expiry) clearTimeout(chat.expiry);
    if (chat.caret) relay.publish(chat.caret.roomId, keyOf(threadId), null);
    chats.delete(threadId);
  };

  return {
    /** The chat sent a model request: it is awake, and warm until `warmUntil`. */
    requested(threadId: string, request: { agentName: string | null; warmUntil: number | null }) {
      const chat = chats.get(threadId);
      if (!chat) {
        chats.set(threadId, { ...request, caret: null, expiry: null });
        return;
      }
      if (chat.expiry) clearTimeout(chat.expiry);
      chat.expiry = null;
      chat.warmUntil = request.warmUntil;
      if (chat.agentName === request.agentName) return;
      chat.agentName = request.agentName;
      show(threadId, chat);
    },

    /** A write by the chat committed: its caret moves to where the write ended. */
    place(threadId: string, room: DocumentRoom, cursor: DocCursor) {
      // A chat that sent no request from this process has no lifetime to keep its caret by.
      const chat = chats.get(threadId);
      if (!chat) return;
      const roomId = loroRoomName(room);
      if (chat.caret && chat.caret.roomId !== roomId)
        relay.publish(chat.caret.roomId, keyOf(threadId), null);
      chat.caret = { roomId, cursor };
      show(threadId, chat);
    },

    /** The chat's run ended: the caret stays until its cache goes cold. */
    settled(threadId: string) {
      const chat = chats.get(threadId);
      if (!chat) return;
      const left = (chat.warmUntil ?? 0) - Date.now();
      if (left <= 0) return forget(threadId);
      chat.expiry = setTimeout(() => forget(threadId), left);
      chat.expiry.unref?.();
    },
  };
}
