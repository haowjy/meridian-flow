/** Admission's check that a draft upload is the sending chat's own, named by identity not spelling. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { TopPrimaryChatResolver } from "../../threads/ports/top-primary-chat.js";
import type { UploadIdentityPort } from "./upload-identity.js";

export function createDraftUploadVerifier(deps: {
  identities: Pick<UploadIdentityPort, "lookupUpload">;
  chats: TopPrimaryChatResolver;
}) {
  return async function verifyDraftUpload(
    reference: { documentId: string; intakeId: string },
    threadId: string,
  ): Promise<boolean> {
    const identity = await deps.identities.lookupUpload(reference.documentId);
    if (!identity || identity.intakeId !== reference.intakeId) return false;
    // Another chat's pending upload, named by id, is not this chat's to attach.
    const chat = await deps.chats.resolveTopPrimaryChat(threadId as ThreadId);
    return chat !== null && identity.ownerChatId === chat.chatId;
  };
}
