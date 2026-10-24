/**
 * DockDocumentIdentity — the header of a document open beside the chat: Close
 * and Open in Editor, its path (which navigates), its version chip, and the
 * dock's Collapse at the right. The change controls follow on the same line or
 * wrap under it (DocumentIdentityBar). It takes the place a tab strip has in
 * the Editor, so the document's name shows once.
 */
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import type { ReactNode } from "react";
import { useWorks } from "@/client/query/useWorks";
import type { ContextTab } from "@/client/stores";
import { isDraftOnly } from "@/client/stores";
import {
  DraftReviewBoundary,
  usePresentedDraftReview,
} from "@/features/draft-review/DraftReviewProvider";
import { DocumentIdentityBar } from "../context/DocumentIdentityBar";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import {
  DockDocumentCommands,
  DockViewFailureNote,
  useDockViewFailed,
} from "./DockDocumentCommands";
import { type DockDocument, useDockDocumentStore } from "./dock-document-store";
import { ReviewLaunchContext, useDockReviewLauncher } from "./useAiDraftLauncher";

const noopCommitted = () => undefined;

export function DockDocumentIdentity({
  projectId,
  document: dockDocument,
  trailing,
}: {
  projectId: string;
  document: DockDocument;
  trailing: ReactNode;
}) {
  const review = usePresentedDraftReview();
  const launch = useDockReviewLauncher(projectId, dockDocument);
  return (
    <ReviewLaunchContext.Provider value={launch}>
      <DraftReviewBoundary value={review}>
        <DockIdentityBody projectId={projectId} document={dockDocument} trailing={trailing} />
      </DraftReviewBoundary>
    </ReviewLaunchContext.Provider>
  );
}

function DockIdentityBody({
  projectId,
  document: dockDocument,
  trailing,
}: {
  projectId: string;
  document: DockDocument;
  trailing: ReactNode;
}) {
  const tab = dockDocument.tab;
  const closeDocument = useDockDocumentStore((state) => state.closeDocument);
  const openInEditor = useOpenDocumentInEditor();
  const archivedWork = useDockArchivedWork(projectId, tab);
  const failed = useDockViewFailed();
  return (
    <DocumentIdentityBar
      key={tab.documentId}
      variant="header"
      leading={<DockDocumentCommands document={dockDocument} failed={failed} />}
      notice={failed ? <DockViewFailureNote /> : null}
      trailing={trailing}
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

/**
 * The archived Work that freezes a document, if any: the Work that owns its file, or the
 * Work whose draft of it is under review (`reviewWorkId`), as the Editor freezes both.
 */
export function useDockArchivedWork(
  projectId: string,
  tab: ContextTab,
  reviewWorkId: string | null = null,
): Work | null {
  const { works } = useWorks(projectId);
  const workId =
    tab.kind !== "new" && tab.workId && isWorkScopedScheme(tab.scheme) ? tab.workId : reviewWorkId;
  const work = workId ? works?.find((candidate) => candidate.id === workId) : undefined;
  return work && isWorkArchived(work) ? work : null;
}
