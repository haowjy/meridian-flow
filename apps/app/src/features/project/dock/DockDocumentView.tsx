/**
 * DockDocumentView — the dock's one document, shown in the standard editor.
 *
 * It is another view of the Editor's document, not a reduced one: the same
 * chrome (identity bar, review header, archived notice), the same host and
 * session path, the same toolbar and link following. What differs is that
 * there is one document and no tab bar; the title menu in the dock header
 * replaces it. The slot stores the tab it was opened with; this view follows
 * the resource projection so a rename elsewhere keeps the document's name and
 * path current, and a removed document closes the slot.
 *
 * The editor shell takes the dock's material (transparent), because the dock
 * slot paints the background.
 */
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { useEffect } from "react";
import { useWorks } from "@/client/query/useWorks";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { ContextDocumentHost } from "../context/ContextDocumentHost";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { DocumentPaneChrome } from "../context/DocumentPaneChrome";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { type DockDocument, useDockViewStore } from "./dock-view-store";
import { useDockDocumentTab } from "./use-dock-document-tab";

const noopCommitted = () => undefined;

export function DockDocumentView({
  projectId,
  document: dockDocument,
  visible,
}: {
  projectId: string;
  document: DockDocument;
  /** Whether the dock is on screen; a hidden dock's editor chrome stands down. */
  visible: boolean;
}) {
  const closeDocument = useDockViewStore((state) => state.closeDocument);
  const openInEditor = useOpenDocumentInEditor();
  const { works } = useWorks(projectId);
  const { controller } = useDraftReview();
  const { tab, gone } = useDockDocumentTab(projectId, dockDocument);
  useEffect(() => {
    if (gone) closeDocument();
  }, [gone, closeDocument]);
  if (gone) return null;

  const work = tab.workId ? works?.find((candidate) => candidate.id === tab.workId) : undefined;
  const archived = work && isWorkArchived(work) && isWorkScopedProjectContextScheme(tab.scheme);
  const reviewDraftId =
    controller.inlineReview?.documentId === tab.documentId ? controller.inlineReview.draftId : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <DocumentPaneChrome
        projectId={projectId}
        editorWorkId={tab.workId ?? null}
        tab={tab}
        reviewDraftId={reviewDraftId}
        archivedWork={archived ? work : null}
        identityReadOnly={Boolean(archived)}
        onCloseTab={closeDocument}
        // The projection above follows a rename; the dock keeps no tab to patch.
        onCommitted={noopCommitted}
        onOpenExisting={(scheme, path, owner) => {
          closeDocument();
          openInEditor({ scheme, path, ...owner });
        }}
      />
      {tab.kind === "tracked" ? (
        <div className="relative min-h-0 flex-1">
          <ContextDocumentHost
            key={tab.documentId}
            projectId={projectId}
            tab={tab}
            active={visible}
            readOnly={Boolean(archived)}
            editorClassName="bg-transparent"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ContextViewerBareHost
            projectId={projectId}
            editorWorkId={tab.workId ?? null}
            tab={tab}
          />
        </div>
      )}
    </div>
  );
}
