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
  const archivedWork = useDockArchivedWork(projectId, tab);
  return (
    <DocumentIdentityBar
      key={tab.documentId}
      variant="header"
      leading={<DockDocumentCommands projectId={projectId} document={dockDocument} />}
      trailing={trailing}
      projectId={projectId}
      editorWorkId={tab.kind === "new" ? null : (tab.workId ?? null)}
      tab={tab}
      readOnly={Boolean(archivedWork)}
      onCloseDraftOnly={isDraftOnly(tab) ? () => close(dockDocument.key) : undefined}
      // The dock follows a rename through the resource projection; it keeps no tab to patch.
      onCommitted={noopCommitted}
      onOpenExisting={(scheme, path, owner) => openInEditor({ scheme, path, ...owner })}
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
