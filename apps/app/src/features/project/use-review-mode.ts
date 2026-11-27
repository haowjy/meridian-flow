import { createContext, useContext, useMemo } from "react";
import { useLastShownDocument, writeLastShownDocument } from "@/client/project-shell/store";
import type { ReviewMode } from "@/features/draft-review/review-mode";
import { useAccountId } from "./context/account-feature-context";
import { useOptionalPanePlace } from "./pane-place";
import type { MainReviewControls } from "./routing/main-review";
import type { ReviewTarget } from "./routing/project-address";
import { type DocumentPaint, useOwnerDraftRows } from "./views";

export type DraftAddressAdmission = "pending" | "admitted" | "unavailable" | "failed";

export type MainReviewAddress = {
  documentId: string | undefined;
  itemKey: string | undefined;
  admission: DraftAddressAdmission | undefined;
  review: ReviewTarget | undefined;
  changeId: string | undefined;
  controls: MainReviewControls | undefined;
};
export const MainReviewAddressContext = createContext<MainReviewAddress | null>(null);

export function useHostReviewMode(
  projectId: string,
  documentId: string | null,
  paint: DocumentPaint,
): ReviewMode | null {
  const accountId = useAccountId();
  const place = useOptionalPanePlace();
  const address = useContext(MainReviewAddressContext);
  const slot = useLastShownDocument(accountId, projectId);
  const draft = paint.draft;
  const main =
    place === "main" &&
    address?.review &&
    address.controls &&
    address.documentId === documentId &&
    address.itemKey === draft?.itemKey
      ? address
      : null;
  const side = place === "side" && slot?.review && slot.documentId === documentId ? slot : null;
  const target = main?.review ?? side?.review ?? null;
  const changeId = (main ? main.changeId : side?.changeId) ?? null;
  const controls = main?.controls ?? null;
  const rows = useOwnerDraftRows(projectId, target ? (draft?.draftId ?? null) : null);
  const listed =
    rows.status === "loading"
      ? null
      : rows.rows.some((row) => row.documentId === documentId && row.pending);
  return useMemo((): ReviewMode | null => {
    if (!documentId || !draft || !target) return null;
    const base = {
      projectId,
      documentId,
      draftId: draft.draftId,
      itemKey: draft.itemKey,
      target,
      changeId,
      listed,
    };
    if (controls) return { ...base, ...controls, retarget: controls.retarget };
    const write = (next: { review?: string; changeId?: string }) =>
      writeLastShownDocument(accountId, projectId, {
        documentId,
        ...(slot?.workId ? { workId: slot.workId } : {}),
        ...next,
      });
    return {
      ...base,
      close: () => write({}),
      focus: (id) => write({ review: target, changeId: id }),
      retarget: (review) => write({ review }),
    };
  }, [accountId, projectId, documentId, draft, target, changeId, listed, controls, slot?.workId]);
}
