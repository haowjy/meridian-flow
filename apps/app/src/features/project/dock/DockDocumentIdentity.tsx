/**
 * DockDocumentIdentity — the header of a document open beside the chat: Close
 * and Open in Editor, its path (which navigates), its version chip, and the
 * dock's Collapse at the right. The change controls follow on the same line or
 * wrap under it (DocumentIdentityBar). It takes the place a tab strip has in
 * the Editor, so the document's name shows once.
 */
import { type ReactNode, useState } from "react";
import { isDraftOnly } from "@/client/stores";
import {
  DraftReviewBoundary,
  usePresentedDraftReview,
} from "@/features/draft-review/DraftReviewProvider";
import { DocumentIdentityBar } from "../context/DocumentIdentityBar";
import { useDocumentFreeze } from "../context/use-document-freeze";
import { type OpenDocumentTab, useOpenDocumentActions } from "../open-documents";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { DockDocumentCommands } from "./DockDocumentCommands";

const noopCommitted = () => undefined;

export function DockDocumentIdentity({
  projectId,
  document: dockDocument,
  trailing,
}: {
  projectId: string;
  document: OpenDocumentTab;
  trailing: ReactNode;
}) {
  const review = usePresentedDraftReview();
  return (
    <DraftReviewBoundary value={review}>
      <DockIdentityBody projectId={projectId} document={dockDocument} trailing={trailing} />
    </DraftReviewBoundary>
  );
}

function DockIdentityBody({
  projectId,
  document: dockDocument,
  trailing,
}: {
  projectId: string;
  document: OpenDocumentTab;
  trailing: ReactNode;
}) {
  const tab = dockDocument.tab;
  const { close } = useOpenDocumentActions(projectId);
  const openInEditor = useOpenDocumentInEditor();
  // The identity bar renames and moves the file, which only the file's own Work freezes.
  const fileFrozen = useDocumentFreeze(projectId, tab, null) !== null;
  const [focusReview, setFocusReview] = useState<string | null>(null);
  return (
    <DocumentIdentityBar
      key={tab.documentId}
      variant="header"
      leading={<DockDocumentCommands projectId={projectId} document={dockDocument} />}
      trailing={trailing}
      projectId={projectId}
      editorWorkId={tab.kind === "new" ? null : (tab.workId ?? null)}
      tab={tab}
      readOnly={fileFrozen}
      onCloseDraftOnly={isDraftOnly(tab) ? () => close(dockDocument.key) : undefined}
      focusReview={focusReview}
      onFocusReview={setFocusReview}
      // The dock follows a rename through the resource projection; it keeps no tab to patch.
      onCommitted={noopCommitted}
      onOpenExisting={(scheme, path, owner) => openInEditor({ scheme, path, ...owner })}
    />
  );
}
