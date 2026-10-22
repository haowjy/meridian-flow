/**
 * The chat's composer, reachable from its header: the uploads menu lives in the pane header,
 * outside `ChatView`, yet a chosen file lands in the composer below. `ChatView` registers its
 * composer under its thread id; the menu inserts through the same handle the `@` picker's
 * chip goes through.
 */
import { type RefObject, useEffect } from "react";
import type { ComposerHandle } from "@/components/app/composer";
import type { AuthoritativeReference } from "@/core/completion";

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

/** Adds the file to the message being written; false when that chat's composer is not mounted. */
export function insertIntoChatComposer(
  threadId: string,
  reference: AuthoritativeReference,
  fileKind: "document" | "asset",
): boolean {
  const handle = composers.get(threadId)?.current;
  if (!handle) return false;
  handle.insertReference(reference, fileKind);
  return true;
}

/** Drops the chips for a file the writer just deleted, so the message can't send a gone file. */
export function removeFromChatComposer(threadId: string, documentId: string): void {
  composers.get(threadId)?.current?.removeReferences(documentId);
}
