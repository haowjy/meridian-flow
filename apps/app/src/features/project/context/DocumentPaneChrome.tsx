/**
 * DocumentPaneChrome — the strip above an open document's editor: the passage
 * notice, the review header, the archived-Work notice, and the identity bar.
 * The Editor's page and the dock's document stack the same chrome, so an open
 * document looks and behaves alike wherever it is shown.
 */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { Work } from "@meridian/contracts/works";
import type { ContextTab } from "@/client/stores";
import { DraftReviewHeader } from "@/features/editor/DraftReviewHeader";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { ArchivedWorkNotice } from "../work/ArchivedWorkNotice";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import type { IdentityCommitOwnership, IdentityCommitted } from "./use-identity-commit";

export type DocumentPaneChromeProps = {
  projectId: string;
  /** The Work whose files this surface edits; identity moves resolve against it. */
  editorWorkId: string | null;
  tab: ContextTab;
  /** The draft under inline review in this document, if any. */
  reviewDraftId: string | null;
  /** Set when the document is frozen by its archived Work. */
  archivedWork: Work | null;
  /** The identity bar can't rename or move the document. */
  identityReadOnly: boolean;
  onCloseTab: (documentId: string) => void;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string, owner: ContextOwner) => void;
};

export function DocumentPaneChrome({
  projectId,
  editorWorkId,
  tab,
  reviewDraftId,
  archivedWork,
  identityReadOnly,
  onCloseTab,
  onCommitted,
  onOpenExisting,
}: DocumentPaneChromeProps) {
  return (
    <>
      {/* A jump that could not find its passage says so here, over the page
          rather than in the layout. */}
      <PassageNotice documentId={tab.documentId} />
      {/* Review banner — above the identity bar so it's the first chrome
          the writer sees when entering review mode. */}
      {reviewDraftId ? (
        <DraftReviewHeader
          documentId={tab.documentId}
          draftId={reviewDraftId}
          onCloseDraftOnly={
            tab.kind !== "new" && tab.draftOnly ? () => onCloseTab(tab.documentId) : undefined
          }
        />
      ) : null}
      {archivedWork ? (
        <ArchivedWorkNotice projectId={projectId} work={archivedWork} className="px-4 pt-3" />
      ) : null}
      {/* Identity bar — the top edge of the page every open document
          shares. Keyed by document so edit state never crosses tabs. */}
      <DocumentIdentityBar
        key={tab.documentId}
        projectId={projectId}
        editorWorkId={editorWorkId}
        tab={tab}
        readOnly={identityReadOnly}
        onCommitted={onCommitted}
        onOpenExisting={onOpenExisting}
      />
    </>
  );
}
