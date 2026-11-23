/**
 * MobileDocumentReview — the column a phone document's editor sits in: Review changes' bar above
 * it while the page is in Review changes, else what an Apply brought back. The editor keeps one
 * place in this tree, so entering and leaving Review changes never remounts it.
 */

import { type ReactNode, useRef } from "react";
import type { OpenDocument } from "@/client/stores";
import { DraftNoticeLine, useDocumentNotice } from "@/features/draft-review/CommandNotice";
import type { DraftNotice } from "@/features/draft-review/draft-notices";
import { fitReviewLine, ReviewBar } from "@/features/draft-review/ReviewBar";
import { useReviewMode } from "@/features/draft-review/review-mode";
import {
  type ManuscriptState,
  ManuscriptStateSlot,
  useManuscriptState,
} from "@/features/editor/ManuscriptStateNotice";
import { useFocusSuccession } from "@/lib/focus-follow";
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
  const notice = useDocumentNotice(projectId, document.documentId);
  const topFocus = useRef<HTMLDivElement>(null);
  useFocusSuccession(topFocus);

  return (
    <MobileKeyboardAware>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Holds the focus while a Discard's notice takes the review row's controls, and back. */}
        <div ref={topFocus} className="contents">
          {mode ? (
            <div
              ref={fitReviewLine}
              data-review-line
              className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-review"
              style={{
                paddingLeft: "calc(0.5rem + env(safe-area-inset-left))",
                paddingRight: "calc(0.25rem + env(safe-area-inset-right))",
              }}
            >
              {notice ? <DraftNoticeLine notice={notice} className="flex-auto" /> : null}
              <ReviewBar />
            </div>
          ) : (
            <ManuscriptStateRow state={manuscriptState} notice={notice} />
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </MobileKeyboardAware>
  );
}

/**
 * What an Apply brought back, in a row of the review header's own height and inset, so the
 * line takes the header's place instead of pushing the page. The version chip is in the
 * toolbar row, as on a desktop.
 */
function ManuscriptStateRow({
  state,
  notice,
}: {
  state: ManuscriptState | null;
  notice: DraftNotice | null;
}) {
  if (!state && !notice) return null;
  return (
    <div
      className="flex min-h-12 shrink-0 items-center border-b border-border-subtle bg-review"
      style={{
        paddingLeft: "calc(0.25rem + env(safe-area-inset-left))",
        paddingRight: "calc(0.25rem + env(safe-area-inset-right))",
      }}
    >
      {notice ? (
        <DraftNoticeLine notice={notice} className="flex-1" />
      ) : (
        <ManuscriptStateSlot state={state} touch />
      )}
    </div>
  );
}
