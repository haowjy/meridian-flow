/**
 * DockDocumentIdentity — the header of a document open beside the chat: Close
 * and Open in Editor, its path (which navigates), its version chip, and the
 * dock's Collapse at the right. The change controls follow on the same line or
 * wrap under it (DocumentIdentityBar). It takes the place a tab strip has in
 * the Editor, so the document's name shows once.
 */
import type { ReactNode } from "react";
import { DocumentIdentityBar } from "../context/DocumentIdentityBar";
import { useDocumentFreeze } from "../context/use-document-freeze";
import { useIsDraftOnly } from "../context/use-draft-only-presentation";
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
  return <DockIdentityBody projectId={projectId} document={dockDocument} trailing={trailing} />;
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
  const draftOnly = useIsDraftOnly(projectId)(tab.documentId);
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
      onCloseDraftOnly={draftOnly ? () => close(dockDocument.key) : undefined}
      // The dock follows a rename through the resource projection; it keeps no tab to patch.
      onCommitted={noopCommitted}
      onOpenExisting={(scheme, path, owner) => openInEditor({ scheme, path, ...owner })}
    />
  );
}
