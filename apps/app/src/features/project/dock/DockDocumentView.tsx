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

import { t } from "@lingui/core/macro";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { isWorkArchived } from "@meridian/contracts/works";
import { useCallback } from "react";
import { useWorks } from "@/client/query/useWorks";
import { PaintCapture, PaintHold, PaintScope } from "@/components/app/PaintHold";
import {
  DraftReviewBoundary,
  useEditorDraftReview,
} from "@/features/draft-review/DraftReviewProvider";
import { useAccountResourceReplica } from "../context/account-feature-context";
import { ContextDocumentHost } from "../context/ContextDocumentHost";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { DocumentPaneChrome } from "../context/DocumentPaneChrome";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { type DockDocument, useDockViewStore } from "./dock-view-store";

const noopCommitted = () => undefined;

export function DockDocumentView(props: {
  projectId: string;
  document: DockDocument;
  visible: boolean;
}) {
  const review = useEditorDraftReview();
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
  document: DockDocument;
  /** Whether the dock is on screen; a hidden dock's editor chrome stands down. */
  visible: boolean;
}) {
  const closeDocument = useDockViewStore((state) => state.closeDocument);
  const openInEditor = useOpenDocumentInEditor();
  const { works } = useWorks(projectId);
  const resources = useAccountResourceReplica();
  const tab = dockDocument.tab;
  const onUntitledBecameNonEmpty = useCallback(async () => {
    if (tab.kind === "new") await resources.markCreateEligible({ handle: tab.resourceHandle });
  }, [resources, tab]);

  const ownerWorkId = tab.kind === "new" ? null : tab.workId;
  const work = ownerWorkId ? works?.find((candidate) => candidate.id === ownerWorkId) : undefined;
  const archived =
    work &&
    tab.kind !== "new" &&
    isWorkArchived(work) &&
    isWorkScopedProjectContextScheme(tab.scheme);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <DocumentPaneChrome
        projectId={projectId}
        editorWorkId={ownerWorkId ?? null}
        tab={tab}
        archivedWork={archived ? work : null}
        identityReadOnly={Boolean(archived)}
        onCloseTab={closeDocument}
        // The projection above follows a rename; the dock keeps no tab to patch.
        onCommitted={noopCommitted}
        onOpenExisting={(scheme, path, owner) => {
          const store = useDockViewStore.getState();
          const claim = store.claim();
          openInEditor(
            { scheme, path, ...owner },
            {
              afterCommit: () => {
                if (useDockViewStore.getState().isCurrent(claim)) closeDocument();
              },
            },
          );
        }}
      />
      {tab.kind !== "viewer" ? (
        <div className="relative min-h-0 flex-1">
          <ContextDocumentHost
            key={tab.documentId}
            projectId={projectId}
            tab={tab}
            active={visible}
            onCloseDraftOnly={closeDocument}
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
