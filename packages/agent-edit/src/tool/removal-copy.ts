import { CONTEXT_URI_SCHEME_NAMES, type ContextUriScheme } from "@meridian/contracts/context-uri";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";

export function removalPhrase(
  removal: DocumentRemovalRecord | null | undefined,
  thisChat?: string,
): string {
  if (!removal) return "deleted";
  const { actor } = removal;
  const verb = removal.reason === "deleted" ? "deleted" : "discarded from the draft";
  const name = actor?.kind === "agent" && actor.chatId === thisChat ? "you" : removerName(actor);
  return name ? `${verb} by ${name}` : verb;
}

export function removerName(actor: DocumentRemovalRecord["actor"]): string | null {
  switch (actor?.kind) {
    case "user":
      return actor.displayName;
    case "agent":
      return actor.chatTitle ? `the AI in "${actor.chatTitle}"` : "the AI in a chat";
    default:
      return null;
  }
}

export function survivingDraftNotice(
  removal: DocumentRemovalRecord | null | undefined,
  scheme: ContextUriScheme,
): string {
  const name = removerName(removal?.actor ?? null);
  return `Deleted from ${CONTEXT_URI_SCHEME_NAMES[scheme]}${name ? ` by ${name}` : ""}. Your draft still has it; Apply brings it back.`;
}

export function removedFile(removal: DocumentRemovalRecord | null | undefined): {
  status: "document_not_found";
  message: string;
} {
  if (removal?.reason === "deleted") {
    return {
      status: "document_not_found",
      message: `This file is in the trash. It was ${removalPhrase(removal)}.`,
    };
  }
  return {
    status: "document_not_found",
    message: `File not found. This file was ${removalPhrase(removal)}.`,
  };
}
