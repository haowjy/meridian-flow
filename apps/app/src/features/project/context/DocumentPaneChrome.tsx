/**
 * DocumentPaneChrome — what sits above an open document's editor: the passage
 * notice, the frozen-document notice (an archived Work, a trashed chat), the document's properties, and on Live what the Work's draft does to it. Main's page and the side's
 * document stack the same chrome. The document's identity and state (an Agent file's included)
 * are elsewhere: in main at the end of the toolbar row, in the side in its header (the Live
 * menu lists other owners' drafts).
 */
import type { OpenDocument } from "@/client/stores";
import { DraftedDeleteNotice } from "@/features/draft-review/DraftedDeleteNotice";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { DocumentFreezeNotice } from "./DocumentFreezeNotice";
import { DocumentProperties } from "./DocumentProperties";
import { LiveDraftNotice } from "./LiveDraftNotice";
import type { DocumentFreeze } from "./use-document-freeze";

export type DocumentPaneChromeProps = {
  projectId: string;
  document: OpenDocument;
  /** Set when the document as shown is frozen: by its archived Work, or a trashed chat. */
  freeze: DocumentFreeze | null;
};

export function DocumentPaneChrome({ projectId, document, freeze }: DocumentPaneChromeProps) {
  return (
    <>
      {/* A jump that could not find its passage says so here, over the page
          rather than in the layout. */}
      <PassageNotice documentId={document.documentId} />
      {freeze ? (
        <DocumentFreezeNotice projectId={projectId} freeze={freeze} className="px-4 pt-3" />
      ) : null}
      <DocumentProperties projectId={projectId} document={document} />
      <DraftedDeleteNotice documentId={document.documentId} />
      <LiveDraftNotice projectId={projectId} document={document} />
    </>
  );
}
