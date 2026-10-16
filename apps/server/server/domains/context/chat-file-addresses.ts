/**
 * One answer to "where are this chat's files": the uploads and Scratch addresses of a chat in
 * the caller's project, computed from the chat's real owners. Errors for near-miss spellings
 * and the thread tools' not-connected pointer share it, so they name only addresses that resolve.
 */
import { formatParsedContextUri } from "@meridian/contracts/context-uri";
import type { ThreadId } from "@meridian/contracts/runtime";
import { decodeWorkSlug } from "@meridian/contracts/works";
import type { TopPrimaryChatResolver } from "../threads/ports/top-primary-chat.js";
import type { ChatUploadsOwners } from "./chat-uploads-owners.js";
import type { ScratchLineages } from "./scratch-owner.js";

export interface ChatFileAddresses {
  /** The chat's top primary chat's uploads, `uploads://@[c15]/`. */
  uploads: string;
  /** Its named Work's Scratch (`scratch://@tea-notes/`), or in No Work its lineage's (`scratch://@[c12]/`). */
  scratch: string;
}

export interface ChatFileLookup {
  /** Null unless `ref` is a live chat of `projectId`. */
  byRef(projectId: string, ref: string): Promise<ChatFileAddresses | null>;
}

export interface ChatFileLookupDeps {
  chats: ChatUploadsOwners;
  topPrimaryChats: TopPrimaryChatResolver;
  lineages: ScratchLineages;
  /** The slug of the named Work the chat is bound to; null in No Work. */
  namedWorkSlug(threadId: string): Promise<string | null>;
}

export function createChatFileLookup(deps: ChatFileLookupDeps): ChatFileLookup {
  return {
    async byRef(projectId, ref) {
      const chat = await deps.chats.byRef(projectId, ref);
      if (!chat?.live) return null;
      const top = await deps.topPrimaryChats.resolveTopPrimaryChat(chat.chatId as ThreadId);
      if (!top) return null;
      const workSlug = decodeWorkSlug(await deps.namedWorkSlug(chat.chatId));
      const lineage = workSlug ? null : await deps.lineages.rootForThreadRef(projectId, ref);
      if (!workSlug && !lineage) return null;
      return {
        uploads: formatParsedContextUri("uploads", "", { kind: "chat", chatRef: top.chatRef }),
        scratch: workSlug
          ? formatParsedContextUri("scratch", "", { kind: "work", workSlug })
          : formatParsedContextUri("scratch", "", {
              kind: "lineage",
              rootThreadRef: lineage?.rootThreadRef ?? "",
            }),
      };
    },
  };
}
