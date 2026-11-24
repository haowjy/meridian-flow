import { createContext, useContext, useMemo } from "react";
import { useLastShownDocument, writeLastShownDocument } from "@/client/project-shell/store";
import type { ReviewMode } from "@/features/draft-review/review-mode";
import { useAccountId } from "./context/account-feature-context";
import { useOptionalPanePlace } from "./pane-place";
import type { MainReviewControls } from "./routing/main-review";
import type { ReviewTarget } from "./routing/project-address";
import { type DocumentPaint, useOwnerDraftRows } from "./views";

/** The route's verdict on the draft item an address names, asked of the server by owner and item. */
export type DraftAddressAdmission = "pending" | "admitted" | "unavailable" | "failed";

/** The review main's address names, and the route's verdict on it. Null off a document address. */
export type MainReviewAddress = {
  documentId: string | undefined;
  itemKey: string | undefined;
  admission: DraftAddressAdmission | undefined;
  /** Review changes is on, against this; undefined is the plain draft. */
  review: ReviewTarget | undefined;
  /** The change in focus in Review changes. */
  changeId: string | undefined;
  controls: MainReviewControls | undefined;
};
export const MainReviewAddressContext = createContext<MainReviewAddress | null>(null);

/**
 * The host's Review changes: main's from its address,
 * the side's from its stored slot, which carries what main's address does beyond the pin. Null on
 * Live, on a plain draft, and in a host that is not on screen.
 */
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
    // The side has no history: closing clears the slot's review, and Back never closes it.
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
