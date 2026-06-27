/**
 * useReverseMutation — React Query mutations for chat turn undo/redo.
 *
 * The editor is updated by server-side Yjs sync. These mutations deliberately
 * own only the footer's local toggle/status feedback.
 */
import { useMutation } from "@tanstack/react-query";

import {
  type ReverseDocumentInput,
  type ReverseTurnInput,
  reverseDocument,
  reverseTurn,
} from "@/client/api/reverse-api";

export function useReverseDocumentMutation(threadId: string) {
  return useMutation({
    mutationFn: (input: ReverseDocumentInput) => reverseDocument(threadId, input),
  });
}

export function useReverseTurnMutation(threadId: string) {
  return useMutation({
    mutationFn: (input: ReverseTurnInput) => reverseTurn(threadId, input),
  });
}
