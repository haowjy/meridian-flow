import { useCallback } from "react";
import {
  type OpenContextRoute,
  useCaptureProjectNavigation,
} from "../routing/ProjectNavigationContext";
import { useAccountResourceReplica } from "./account-feature-context";

/** New document: an Untitled document in Unfiled, opened in main with the caret. */
export function useNewDocument(
  projectId: string,
  open: OpenContextRoute | null,
): (() => void) | undefined {
  const captureNavigation = useCaptureProjectNavigation();
  const resources = useAccountResourceReplica();
  const create = useCallback(async () => {
    if (!open) return;
    const isCurrent = captureNavigation?.();
    const reservation = await resources.reserveDocument(projectId);
    if (reservation.content.kind !== "opened") throw new Error("Local document is unavailable");
    try {
      if (isCurrent?.() === false) return;
      const documentId = reservation.content.handle.documentId;
      const result = await open(
        { scheme: "unfiled", path: "", documentId },
        {
          isCurrent,
          focus: true,
          tab: {
            kind: "new",
            documentId,
            name: reservation.name,
            resourceHandle: reservation.key.handle,
          },
        },
      );
      if (result.kind === "failed") throw result.error;
    } finally {
      reservation.content.handle.release();
    }
  }, [projectId, resources, open, captureNavigation]);
  return open ? () => void create().catch((error: unknown) => reportError(error)) : undefined;
}
