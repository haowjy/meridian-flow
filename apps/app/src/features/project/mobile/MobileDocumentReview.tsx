import type { ReactNode } from "react";
import type { OpenDocument } from "@/client/stores";
import { PageNotice } from "@/features/draft-review/PageNotice";
import { ReviewBar } from "@/features/draft-review/ReviewBar";
import { ReviewChangesButton } from "@/features/draft-review/ReviewChangesButton";
import { useReviewMode } from "@/features/draft-review/review-mode";
import {
  type ManuscriptState,
  ManuscriptStateSlot,
  useManuscriptState,
} from "@/features/editor/ManuscriptStateNotice";
import { MobileKeyboardAware } from "./MobileKeyboardAware";

export function MobileDocumentReview({
  projectId,
  document,
  children,
}: {
  projectId: string;
  document: OpenDocument;
  children: ReactNode;
}) {
  const mode = useReviewMode();
  const manuscriptState = useManuscriptState(projectId, document);

  return (
    <MobileKeyboardAware>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {mode ? (
          <div
            className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-review"
            style={{
              paddingLeft: "calc(0.5rem + env(safe-area-inset-left))",
              paddingRight: "calc(0.25rem + env(safe-area-inset-right))",
            }}
          >
            <ReviewBar />
            <ReviewChangesButton document={document} />
          </div>
        ) : (
          <ManuscriptStateRow state={manuscriptState} />
        )}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <PageNotice projectId={projectId} documentId={document.documentId} />
      </div>
    </MobileKeyboardAware>
  );
}

function ManuscriptStateRow({ state }: { state: ManuscriptState | null }) {
  if (!state) return null;
  return (
    <div
      className="flex min-h-12 shrink-0 items-center border-b border-border-subtle bg-review"
      style={{
        paddingLeft: "calc(0.25rem + env(safe-area-inset-left))",
        paddingRight: "calc(0.25rem + env(safe-area-inset-right))",
      }}
    >
      <ManuscriptStateSlot state={state} touch />
    </div>
  );
}
