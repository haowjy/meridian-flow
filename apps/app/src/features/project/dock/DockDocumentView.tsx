/**
 * DockDocumentView — the dock's one document, shown in the standard editor.
 *
 * It is another view of the Editor's document, not a reduced one: the same
 * chrome (identity bar, review header, archived notice), the same host and
 * session path, the same toolbar and link following. What differs is that
 * there is one document and no tab bar; the dock header shows its path and
 * chips instead (`DockDocumentIdentity`). The slot stores the tab it was opened with; this view follows
 * the resource projection so a rename elsewhere keeps the document's name and
 * path current, and a removed document closes the slot.
 *
 * The editor shell takes the dock's material (transparent), because the dock
 * slot paints the background.
 */
import { useCallback } from "react";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { useAccountResourceReplica } from "../context/account-feature-context";
import { ContextDocumentHost } from "../context/ContextDocumentHost";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { DocumentPaneChrome } from "../context/DocumentPaneChrome";
import { useDockArchivedWork } from "./DockDocumentIdentity";
import { type DockDocument, useDockViewStore } from "./dock-view-store";

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
  const { controller } = useDraftReview();
  const resources = useAccountResourceReplica();
  const tab = dockDocument.tab;
  const onUntitledBecameNonEmpty = useCallback(async () => {
    if (tab.kind === "new") await resources.markCreateEligible({ handle: tab.resourceHandle });
  }, [resources, tab]);

  const ownerWorkId = tab.kind === "new" ? null : tab.workId;
  const archived = useDockArchivedWork(projectId, tab);
  const reviewDraftId =
    controller.inlineReview?.documentId === tab.documentId ? controller.inlineReview.draftId : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <DocumentPaneChrome
        projectId={projectId}
        tab={tab}
        reviewDraftId={reviewDraftId}
        archivedWork={archived}
        onCloseTab={closeDocument}
        // The path and its chips are in the dock header (DockDocumentIdentity).
        identity={null}
      />
      {tab.kind !== "viewer" ? (
        <div className="relative min-h-0 flex-1">
          <ContextDocumentHost
            key={tab.documentId}
            projectId={projectId}
            tab={tab}
            active={visible}
            onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
            readOnly={Boolean(archived)}
            editorClassName="bg-transparent"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ContextViewerBareHost
            projectId={projectId}
            editorWorkId={ownerWorkId ?? null}
            tab={tab}
          />
        </div>
      )}
    </div>
  );
}
