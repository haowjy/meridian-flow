/**
 * Main's address and main's document view, kept in step. An address arriving by push or pop (a
 * link, a reload, Back) is a command: it sets the view's pin to the draft it names, or drops the
 * pin when it names none. The shell's own replace is not a command (`locationKey` is the history
 * entry's). After that the view is the owner and the address follows it by replace, so a draft
 * the writer picks, leaves or focuses a change in rewrites the address in place and never adds a
 * Back step.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  type DraftPin,
  readDocumentView,
  setDocumentView,
  useDocumentView,
} from "@/client/project-shell/document-views";
import { getContextTabs, useContextTabsStore, useSelectedDocumentId } from "@/client/stores";
import { useAccountId } from "./context/account-feature-context";
import type { ReviewAddressAdmission } from "./use-review-admission";

function samePin(a: DraftPin | null | undefined, b: DraftPin | null | undefined): boolean {
  return a?.ownerKey === b?.ownerKey && a?.itemKey === b?.itemKey && a?.changeId === b?.changeId;
}

export function useReviewAddressSync({
  projectId,
  selectsTab,
  locationKey,
  reviewOwner,
  address,
  writeItemKey,
}: {
  projectId: string;
  /** The desktop's Write shows the selected tab: an arriving address selects the one it names. */
  selectsTab: boolean;
  locationKey: string | undefined;
  /** Whose draft the address's item reviews (`addressReviewOwner`); null while unresolved. */
  reviewOwner: string | null;
  address: {
    /** Whose draft the address names; a pin writes its own owner back. */
    owner: string | undefined;
    itemKey: string | undefined;
    changeId: string | undefined;
    /** Main's document, as the address resolved it; undefined when main holds no document. */
    documentId: string | undefined;
    admission: ReviewAddressAdmission | undefined;
  };
  writeItemKey: (review: DraftPin | null) => void;
}) {
  const accountId = useAccountId();
  /** The history entry whose address main's view has taken in. */
  const arrived = useRef<string | undefined>(undefined);
  const { documentId } = address;
  const pin = useDocumentView(accountId, projectId, documentId ?? null).pin;
  const selectedDocumentId = useSelectedDocumentId(projectId);

  useLayoutEffect(() => {
    if (!selectsTab || !documentId || documentId === selectedDocumentId) return;
    // The address wins over the persisted selection. With no tab yet, the route installs one.
    const named = getContextTabs(projectId).tabs.find((tab) => tab.documentId === documentId);
    if (named) void useContextTabsStore.getState().selectTab(projectId, named.documentId, named);
  }, [selectsTab, documentId, selectedDocumentId, projectId]);

  useLayoutEffect(() => {
    if (locationKey === undefined || !documentId || arrived.current === locationKey) return;
    if (address.itemKey && (address.admission !== "admitted" || !reviewOwner)) return;
    arrived.current = locationKey;
    const next =
      address.itemKey && reviewOwner
        ? {
            ownerKey: reviewOwner,
            itemKey: address.itemKey,
            ...(address.changeId ? { changeId: address.changeId } : {}),
          }
        : null;
    const current = readDocumentView(accountId, projectId, documentId).pin;
    if (samePin(next, current) || (!next && !current)) return;
    setDocumentView(accountId, projectId, documentId, next ? { pin: next } : { version: "live" });
  }, [documentId, locationKey, reviewOwner, address, accountId, projectId]);

  useEffect(() => {
    if (!documentId || arrived.current !== locationKey) return;
    // The store, not this render's pin: the arrival above set the pin in this same commit, and the
    // render's older pin would write the address back to what the arrival replaced.
    const shown = readDocumentView(accountId, projectId, documentId).pin;
    if (
      (address.itemKey ?? null) === (shown?.itemKey ?? null) &&
      address.changeId === shown?.changeId &&
      (!shown || address.owner === shown.ownerKey)
    )
      return;
    writeItemKey(shown ?? null);
  }, [
    documentId,
    locationKey,
    address.itemKey,
    address.changeId,
    address.owner,
    pin,
    writeItemKey,
    accountId,
    projectId,
  ]);
}
