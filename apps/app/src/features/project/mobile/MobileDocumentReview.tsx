/**
 * MobileDocumentReview — the column a phone document's editor sits in: Review changes' bar above
 * it while the page is in Review changes, else what an Apply brought back; the page's notice
 * floats at its foot. The editor keeps one place in this tree, so entering and leaving Review
 * changes never remounts it.
 */

import { t } from "@lingui/core/macro";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { OpenDocument } from "@/client/stores";
import { IconButton } from "@/components/ui/icon-button";
import { PageNotice } from "@/features/draft-review/PageNotice";
import { ReviewBar } from "@/features/draft-review/ReviewBar";
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
            <IconButton size="xs" variant="quiet" label={t`Close`} onClick={mode.close}>
              <X aria-hidden />
            </IconButton>
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

/**
 * What an Apply brought back, in a row of the review header's own height and inset. The version
 * chip is in the toolbar row, as on a desktop.
 */
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
