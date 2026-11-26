import type { ThreadId } from "@meridian/contracts/runtime";
import type { TopPrimaryChatResolver } from "../../threads/ports/top-primary-chat.js";
import type { UploadIdentityPort } from "./upload-identity.js";

export function createChatUploadVerifier(deps: {
  identities: Pick<UploadIdentityPort, "lookupUpload">;
  chats: TopPrimaryChatResolver;
}) {
  return async function verifyChatUpload(
    reference: { documentId: string; intakeId: string },
    threadId: string,
  ): Promise<boolean> {
    const identity = await deps.identities.lookupUpload(reference.documentId);
    if (!identity || identity.intakeId !== reference.intakeId) return false;
    const chat = await deps.chats.resolveTopPrimaryChat(threadId as ThreadId);
    return chat !== null && identity.ownerChatId === chat.chatId;
  };
}
