/**
 * The app's half of a reference in the chat transcript: where one actually goes.
 *
 * The transcript renders references; the project, the Work, and the tab strip
 * are the app's. This is that seam and it renders nothing of its own — it owns
 * a resolution store for this scope, registers the same port the manuscript's
 * links are drawn from, and hands a followed reference to the tab opener.
 *
 * **A store per scope, not per app.** Answers are keyed by href, and the
 * manuscript's are keyed against the document holding the link — `./cast.md`
 * means different things in different chapters. A message holds no relative
 * links at all, so this scope has no base document and a relative reference in
 * a message is a question that cannot be asked. Sharing one store across both
 * would make it one that could be answered wrongly.
 *
 * **Re-registering is the invalidation.** A rename leaves `[[Old Name]]`
 * spelled the same and pointing somewhere else, so the store is registered
 * against the catalog's revision and every answer from the last one becomes
 * unreachable the moment it changes.
 */

import { type ReactNode, useEffect, useMemo } from "react";

import { createLinkResolution } from "@/core/links";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { useProjectLinkResolver } from "@/features/project/context/project-link-resolver";
import {
  InternalReferenceProvider,
  type InternalReferenceRuntime,
} from "@/rich-content/InternalReference";

export function ProjectTranscriptReferences({
  projectId,
  activeWorkId,
  children,
}: {
  projectId: string;
  activeWorkId: string | null;
  children: ReactNode;
}) {
  const { resolve, revision } = useProjectLinkResolver({ projectId, workId: activeWorkId });
  const openDocument = useOpenProjectDocument(projectId);

  // One store for as long as this project and Work are on screen. The scope's
  // own changes ride `registerResolver` below rather than a new store, so a
  // rename never remounts the transcript.
  const resolution = useMemo(() => createLinkResolution(), []);
  useEffect(() => () => resolution.destroy(), [resolution]);

  useEffect(() => {
    if (!resolve) return;
    return resolution.registerResolver(resolve);
    // `revision` is in here without being read: registering against a different
    // catalog is how an answer about the old one becomes unreachable.
  }, [resolution, resolve, revision]);

  const runtime = useMemo<InternalReferenceRuntime>(
    () => ({
      resolution,
      open: (documentId) => {
        void openDocument({ documentId, workId: activeWorkId });
      },
    }),
    [activeWorkId, openDocument, resolution],
  );

  return <InternalReferenceProvider runtime={runtime}>{children}</InternalReferenceProvider>;
}
