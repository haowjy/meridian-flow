/**
 * DockDocumentView — the dock's one document, shown in the standard editor.
 *
 * It is another view of the Editor's document, not a reduced one: the same
 * chrome (identity bar, review header, frozen-document notice), the same host and
 * session path, the same toolbar and link following. What differs is that
 * there is one document and no tab bar; the title menu in the dock header
 * replaces it. The slot stores the tab it was opened with; this view follows
 * the resource projection so a rename elsewhere keeps the document's name and
 * path current, and a removed document closes the slot.
 *
 * The editor shell and the file viewer take the dock's material (transparent),
 * because the dock slot paints the background.
 */

import { t } from "@lingui/core/macro";
import { useCallback } from "react";
import { PaintCapture, PaintHold, PaintScope } from "@/components/app/PaintHold";
import {
  DraftReviewBoundary,
  useDraftReview,
  usePresentedDraftReview,
} from "@/features/draft-review/DraftReviewProvider";
import { useAccountResourceReplica } from "../context/account-feature-context";
import { ContextDocumentHost } from "../context/ContextDocumentHost";
import { ContextViewerHost } from "../context/ContextViewerHost";
import { DocumentPaneChrome } from "../context/DocumentPaneChrome";
import { useDocumentFreeze } from "../context/use-document-freeze";
import { type OpenDocumentTab, useOpenDocumentActions } from "../open-documents";

export function DockDocumentView(props: {
  projectId: string;
  document: OpenDocumentTab;
  visible: boolean;
}) {
  const review = usePresentedDraftReview();
  return (
    <DraftReviewBoundary value={review}>
      <PaintScope active={props.visible}>
        <PaintHold
          status={t`Opening ${props.document.tab.name}`}
          className="relative flex min-h-0 flex-1 flex-col"
        >
          <PaintCapture surface={props.document.tab.documentId} />
          <DockDocumentBody {...props} />
        </PaintHold>
      </PaintScope>
    </DraftReviewBoundary>
  );
}

function DockDocumentBody({
  projectId,
  document: dockDocument,
  visible,
}: {
  projectId: string;
  document: OpenDocumentTab;
  /** Whether the dock is on screen; a hidden dock's editor chrome stands down. */
  visible: boolean;
}) {
  const { close } = useOpenDocumentActions(projectId);
  const closeDocument = () => close(dockDocument.key);
  const resources = useAccountResourceReplica();
  const tab = dockDocument.tab;
  const onUntitledBecameNonEmpty = useCallback(async () => {
    if (tab.kind === "new") await resources.markCreateEligible({ handle: tab.resourceHandle });
  }, [resources, tab]);

  // A draft under review freezes with its owner, as in the Editor.
  const { controller } = useDraftReview();
  const review = controller.inlineReview;
  const reviewing = review?.documentId === tab.documentId && review.shown;
  const freeze = useDocumentFreeze(projectId, tab, reviewing ? controller.ownerKey : null);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <DocumentPaneChrome projectId={projectId} tab={tab} freeze={freeze} reviewNotices={false} />
      {tab.kind !== "viewer" ? (
        <div className="relative min-h-0 flex-1">
          <ContextDocumentHost
            container="dock"
            key={tab.documentId}
            projectId={projectId}
            tab={tab}
            active={visible}
            onCloseDraftOnly={closeDocument}
            onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
            readOnly={freeze !== null}
            editorClassName="bg-transparent"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ContextViewerHost projectId={projectId} tab={tab} className="bg-transparent" />
        </div>
      )}
    </div>
  );
}
