import { type RefObject, useEffect } from "react";
import type { ComposerHandle } from "@/components/app/composer";
import type { DocumentReference } from "@/core/completion";

const composers = new Map<string, RefObject<ComposerHandle | null>>();

export function useRegisterChatComposer(
  threadId: string,
  composer: RefObject<ComposerHandle | null>,
): void {
  useEffect(() => {
    composers.set(threadId, composer);
    return () => {
      if (composers.get(threadId) === composer) composers.delete(threadId);
    };
  }, [threadId, composer]);
}

export function insertIntoChatComposer(
  threadId: string,
  reference: DocumentReference,
  fileKind: "document" | "asset",
): boolean {
  const handle = composers.get(threadId)?.current;
  if (!handle) return false;
  handle.insertReference(reference, fileKind);
  return true;
}

export function removeFromChatComposer(threadId: string, documentId: string): void {
  composers.get(threadId)?.current?.removeReferences(documentId);
}
