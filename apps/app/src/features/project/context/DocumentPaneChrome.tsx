import type { Work } from "@meridian/contracts/works";
import type { OpenDocument } from "@/client/stores";
import { ReviewTreeRow } from "@/features/draft-review/ReviewTreeRow";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { EndedWorkNotice } from "../work/EndedWorkNotice";
import { DocumentProperties } from "./DocumentProperties";

export type DocumentPaneChromeProps = {
  projectId: string;
  document: OpenDocument;
  freeze: Work | null;
};

export function DocumentPaneChrome({ projectId, document, freeze }: DocumentPaneChromeProps) {
  return (
    <>
      <PassageNotice documentId={document.documentId} />
      {freeze ? (
        <EndedWorkNotice projectId={projectId} work={freeze} className="px-4 pt-3" />
      ) : null}
      <DocumentProperties projectId={projectId} document={document} />
      <ReviewTreeRow documentId={document.documentId} />
    </>
  );
}
