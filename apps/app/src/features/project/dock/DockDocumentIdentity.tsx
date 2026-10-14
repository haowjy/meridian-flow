/**
 * DockDocumentIdentity — the header of a document open beside the chat: its
 * path (which navigates) and its chips, in the dock's header row. It takes the
 * place a tab strip has in the Editor, so the document's name shows once.
 */
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useWorks } from "@/client/query/useWorks";
import type { ContextTab } from "@/client/stores";
import { isDraftOnly } from "@/client/stores";
import {
  DraftReviewBoundary,
  usePresentedDraftReview,
} from "@/features/draft-review/DraftReviewProvider";
import { DocumentIdentityBar } from "../context/DocumentIdentityBar";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";
import { ReviewLaunchContext, useDockReviewLauncher } from "./useAiDraftLauncher";

const noopCommitted = () => undefined;

export function DockDocumentIdentity({
  projectId,
  document: dockDocument,
}: {
  projectId: string;
  document: DockDocument;
}) {
  const review = usePresentedDraftReview();
  const launch = useDockReviewLauncher(projectId, dockDocument);
  return (
    <ReviewLaunchContext.Provider value={launch}>
      <DraftReviewBoundary value={review}>
        <DockIdentityBody projectId={projectId} document={dockDocument} />
      </DraftReviewBoundary>
    </ReviewLaunchContext.Provider>
  );
}

function DockIdentityBody({
  projectId,
  document: dockDocument,
}: {
  projectId: string;
  document: DockDocument;
}) {
  const tab = dockDocument.tab;
  const closeDocument = useDockDocumentStore((state) => state.closeDocument);
  const openInEditor = useOpenDocumentInEditor();
  const archivedWork = useDockArchivedWork(projectId, tab);
  return (
    <DocumentIdentityBar
      key={tab.documentId}
      variant="header"
      projectId={projectId}
      editorWorkId={tab.kind === "new" ? null : (tab.workId ?? null)}
      tab={tab}
      readOnly={Boolean(archivedWork)}
      onCloseDraftOnly={isDraftOnly(tab) ? closeDocument : undefined}
      // The dock follows a rename through the resource projection; it keeps no tab to patch.
      onCommitted={noopCommitted}
      onOpenExisting={(scheme, path, owner) => {
        const claim = useDockDocumentStore.getState().claim();
        openInEditor(
          { scheme, path, ...owner },
          {
            afterCommit: () => {
              if (useDockDocumentStore.getState().isCurrent(claim)) closeDocument();
            },
          },
        );
      }}
    />
  );
}

/** The archived Work that freezes a dock document, if any. */
export function useDockArchivedWork(projectId: string, tab: ContextTab): Work | null {
  const { works } = useWorks(projectId);
  if (tab.kind === "new" || !tab.workId || !isWorkScopedProjectContextScheme(tab.scheme))
    return null;
  const work = works?.find((candidate) => candidate.id === tab.workId);
  return work && isWorkArchived(work) ? work : null;
}
