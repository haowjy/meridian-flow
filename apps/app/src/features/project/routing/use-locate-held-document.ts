import { useEffect, useState } from "react";
import { getProjectContextAvailability } from "@/client/api/projects-api";
import { parseContextUri } from "@/lib/context-uri";
import { canonicalDocumentPath } from "./local-document-address";
import type { OpenContextRoute } from "./ProjectNavigationContext";
import type { ProjectAddress } from "./project-address";
import type { createProjectNavigation } from "./project-navigation";

/**
 * A route bound to a document the catalog does not list yet holds: the address answer names the
 * path's occupant, which is another document. The server's identity lookup, once per bound
 * document and address, says where the bound one is now. Returns whether it found nothing.
 */
export function useLocateHeldDocument({
  projectId,
  documentId,
  address,
  editorWorkId,
  navigation,
  openContext,
  refetchAddress,
}: {
  projectId: string;
  /** The bound document the address answer disagrees with; null when nothing is held. */
  documentId: string | null;
  address: ProjectAddress;
  editorWorkId: string | null;
  navigation: ReturnType<typeof createProjectNavigation> | null;
  openContext: OpenContextRoute;
  refetchAddress: () => void;
}): boolean {
  const { destination, lineage } = address;
  const here = destination.kind === "document" ? destination : null;
  const attempt = documentId && here ? `${documentId}|${here.scheme}|${here.path}` : null;
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!attempt || !documentId || !here || !navigation || !editorWorkId) return;
    const ticket = navigation.capture();
    const current = () => navigation.isCurrent(ticket);
    void getProjectContextAvailability(projectId, [documentId]).then(
      ({ resolutions: [resolution] }) => {
        if (!current()) return;
        const located =
          resolution?.kind === "available" ? parseContextUri(resolution.entry.uri) : null;
        if (!located) return setFailed(attempt);
        if (
          located.scheme === here.scheme &&
          canonicalDocumentPath(located.path) === canonicalDocumentPath(here.path)
        )
          // The server places the document here: the answer that named another is stale.
          return refetchAddress();
        void openContext(
          {
            scheme: located.scheme,
            path: located.path,
            workId: editorWorkId,
            ...(lineage ? { rootThreadId: lineage } : {}),
            documentId,
          },
          { replace: true, isCurrent: current },
        );
      },
      () => current() && setFailed(attempt),
    );
    // One lookup per bound document at this address; the rest is read when it settles.
  }, [attempt]);
  return attempt !== null && failed === attempt;
}
