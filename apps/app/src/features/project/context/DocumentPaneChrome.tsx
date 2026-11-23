/**
 * DocumentPaneChrome — what sits above an open document's editor: the passage
 * notice, the archived Work's notice over its own files and the document's properties. Main's page and the side's
 * document stack the same chrome. The document's identity and state (an Agent file's included)
 * are elsewhere: in main at the end of the toolbar row, in the side in its header (the Live
 * menu lists every draft of the document, and its dot says one exists).
 */
import type { Work } from "@meridian/contracts/works";
import type { OpenDocument } from "@/client/stores";
import { ReviewTreeRow } from "@/features/draft-review/ReviewTreeRow";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { EndedWorkNotice } from "../work/EndedWorkNotice";
import { DocumentProperties } from "./DocumentProperties";

export type DocumentPaneChromeProps = {
  projectId: string;
  document: OpenDocument;
  /** The archived or deleted Work whose own file this is (`useDocumentFreeze`). */
  freeze: Work | null;
};

export function DocumentPaneChrome({ projectId, document, freeze }: DocumentPaneChromeProps) {
  return (
    <>
      {/* A jump that could not find its passage says so here, over the page
          rather than in the layout. */}
      <PassageNotice documentId={document.documentId} />
      {freeze ? (
        <EndedWorkNotice projectId={projectId} work={freeze} className="px-4 pt-3" />
      ) : null}
      <DocumentProperties projectId={projectId} document={document} />
      <ReviewTreeRow documentId={document.documentId} />
    </>
  );
}
