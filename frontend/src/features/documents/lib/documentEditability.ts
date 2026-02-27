import type { CollabConnectionState } from "../stores/useCollabStore";

interface ComputeDocumentEditableParams {
  isInitialized: boolean;
  activeDocumentId: string | undefined;
  documentId: string;
  isLoading: boolean;
  collabEnabled: boolean;
  collabConnectionState: CollabConnectionState;
}

/**
 * Determines whether the editor should accept user input.
 *
 * Collab documents must wait for an active WS sync session before becoming
 * editable so local edits do not race with initial collab bootstrap.
 */
export function computeDocumentEditable({
  isInitialized,
  activeDocumentId,
  documentId,
  isLoading,
  collabEnabled,
  collabConnectionState,
}: ComputeDocumentEditableParams): boolean {
  if (!isInitialized || activeDocumentId !== documentId || isLoading) {
    return false;
  }

  if (!collabEnabled) {
    return true;
  }

  return collabConnectionState === "connected";
}
