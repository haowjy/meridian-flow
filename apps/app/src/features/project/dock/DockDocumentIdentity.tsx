/**
 * DockDocumentIdentity — the header of a document open beside the chat: its
 * path (which navigates) and its chips, in the dock's header row. It takes the
 * place a tab strip has in the Editor, so the document's name shows once.
 */
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useWorks } from "@/client/query/useWorks";
import type { ContextTab } from "@/client/stores";
import { DocumentIdentityBar } from "../context/DocumentIdentityBar";
import { useOpenDocumentInEditor } from "../routing/use-open-document-in-editor";
import { type DockDocument, useDockViewStore } from "./dock-view-store";

const noopCommitted = () => undefined;

export function DockDocumentIdentity({
  projectId,
  document: dockDocument,
}: {
  projectId: string;
  document: DockDocument;
}) {
  const tab = dockDocument.tab;
  const closeDocument = useDockViewStore((state) => state.closeDocument);
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
      // The dock follows a rename through the resource projection; it keeps no tab to patch.
      onCommitted={noopCommitted}
      onOpenExisting={(scheme, path, owner) => {
        const claim = useDockViewStore.getState().claim();
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
