/** Explicit neutral shell seams for real EditorView tests; room and paint policy stay with the caller. */

import { vi } from "vitest";
import * as catalog from "@/client/query/useContextCatalog";
import * as threads from "@/client/query/useProjectThreads";
import * as works from "@/client/query/useWorks";
import type { DocumentSession } from "@/core/editor/document-session";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import * as trail from "@/features/change-trail/trail-detail-query";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import * as chrome from "@/features/editor/chrome/chrome-surfaces";
import { EditorView } from "@/features/editor/EditorView";
import * as references from "@/features/editor/references/useReferenceBrowserCatalog";
import * as status from "@/features/editor/SyncStatus";
import * as focus from "@/features/editor/useInlineReviewFocus";
import * as links from "@/features/links";
import * as account from "@/features/project/context/account-feature-context";
import { ContextRemovalCoordinator } from "@/features/project/context/context-removal-coordinator";

export function installEditorShell(registry: LiveDocumentSessionRegistry) {
  const removal = new ContextRemovalCoordinator();
  const seams = [
    vi.spyOn(catalog, "useContextCatalogView").mockReturnValue({
      catalog: null,
      isComplete: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    }),
    vi
      .spyOn(threads, "useProjectThreads")
      .mockReturnValue({ threads: [], isError: false, isFetching: false, refetch: () => {} }),
    vi.spyOn(works, "useWorks").mockReturnValue({
      noWork: { id: "no-work", slug: null, archivedAt: null } as NonNullable<
        ReturnType<typeof works.useWorks>["noWork"]
      >,
      works: [],
      deleted: [],
      creations: new Map(),
      isError: false,
      isFetching: false,
      status: "empty",
      refetch: () => undefined,
    }),
    vi.spyOn(trail, "usePrefetchTrailDetails").mockImplementation(() => {}),
    vi.spyOn(account, "useContextRemovalCoordinator").mockReturnValue(removal),
    vi.spyOn(account, "useOptionalAccountResourceReplica").mockReturnValue(null),
    vi.spyOn(account, "useLiveDocumentSessionRegistry").mockReturnValue(registry),
    vi
      .spyOn(account, "useAccountResourceProjection")
      .mockReturnValue({ snapshot: null, folders: [], records: [], error: null }),
    vi
      .spyOn(links, "useLinkableDocuments")
      .mockReturnValue({ documents: [], revision: "", complete: false }),
    vi.spyOn(references, "useReferenceBrowserCatalog").mockReturnValue(null),
    vi.spyOn(focus, "useInlineReviewFocus").mockImplementation(() => {}),
    vi.spyOn(status, "SyncStatus").mockImplementation(() => null),
    vi.spyOn(chrome, "EDITOR_CHROME_SURFACES", "get").mockReturnValue([]),
  ];
  return {
    dispose() {
      for (const seam of seams) seam.mockRestore();
      removal.dispose();
    },
  };
}

/** Caller supplies real session ownership; no hidden room or paint modes. */
export function ReviewEditorHost({
  documentId,
  projectId,
  session,
  draftOnly,
  observe,
}: {
  documentId: string;
  projectId: string;
  session?: DocumentSession;
  draftOnly?: boolean;
  observe: (review: ReturnType<typeof useDraftReview>) => void;
}) {
  const review = useDraftReview();
  observe(review);
  return (
    <EditorView
      documentId={documentId}
      projectId={projectId}
      session={session}
      localContentReady={!!session}
      draftOnly={draftOnly}
      reviewDraftId={review.controller.inlineReview?.draftId}
    />
  );
}
