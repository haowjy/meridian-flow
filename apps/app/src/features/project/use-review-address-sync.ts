/**
 * Write's URL and the selected tab's review pin, kept in step. An address arriving (a link, a
 * reload, Back) is a command: it selects the tab of the document it names, then sets that tab's
 * pin, or clears it when the address names no review. After that the tab is the owner and the URL follows it, so a pin the writer changes (a
 * Live choice, the focused change) rewrites the address in place.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { getContextTabs, selectedTabOf, tabKey, useContextTabsStore } from "@/client/stores";
import type { OpenDocumentTab } from "./open-documents";
import type { ReviewAddressAdmission } from "./presented-document";

export function useReviewAddressSync({
  projectId,
  selected,
  writing,
  locationKey,
  reviewOwner,
  address,
  writeItemKey,
}: {
  projectId: string;
  selected: OpenDocumentTab | null;
  /** Write on a desktop: the only place the address carries a review. */
  writing: boolean;
  locationKey: string | undefined;
  /** Whose draft the address's item reviews (`addressReviewOwner`); null while unresolved. */
  reviewOwner: string | null;
  address: {
    /** Whose draft the address names; a pin writes its own owner back. */
    owner: string | undefined;
    itemKey: string | undefined;
    changeId: string | undefined;
    /** The document the address resolved to. */
    documentId: string | undefined;
    admission: ReviewAddressAdmission | undefined;
  };
  writeItemKey: (itemKey: string | null, changeId?: string, ownerKey?: string) => void;
}) {
  /** The history entry whose address the tab has taken in. */
  const arrived = useRef<string | undefined>(undefined);
  const key = selected ? tabKey(selected.tab) : null;
  const documentId = selected?.tab.documentId;
  const pin = selected?.tab.reviewPin;

  useLayoutEffect(() => {
    if (!writing || locationKey === undefined || arrived.current === locationKey) return;
    if (address.documentId !== documentId) {
      // The address names a document other than the selected tab's: the address wins over the
      // persisted selection, so select the tab it names. With no tab yet, the route installs one.
      const named = address.documentId
        ? getContextTabs(projectId).tabs.find((tab) => tab.documentId === address.documentId)
        : undefined;
      if (named) void useContextTabsStore.getState().selectTab(projectId, named.documentId, named);
      return;
    }
    if (key === null) return;
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
    if (
      next?.ownerKey === pin?.ownerKey &&
      next?.itemKey === pin?.itemKey &&
      next?.changeId === pin?.changeId
    )
      return;
    useContextTabsStore
      .getState()
      .setTabState(
        projectId,
        key,
        next ? { reviewPin: next, view: { version: "draft" } } : { reviewPin: null },
      );
  }, [writing, key, documentId, locationKey, reviewOwner, address, pin, projectId]);

  const pinnedItem = pin?.itemKey ?? null;
  const pinnedChange = pin?.changeId;
  useEffect(() => {
    if (!writing || key === null || arrived.current !== locationKey) return;
    // The store, not this render's pin: the arrival above set the pin in this same commit, and the
    // render's older pin would write the address back to what the arrival replaced.
    const live = selectedTabOf(getContextTabs(projectId))?.reviewPin;
    if (
      (address.itemKey ?? null) === (live?.itemKey ?? null) &&
      address.changeId === live?.changeId &&
      (!live || address.owner === live.ownerKey)
    )
      return;
    writeItemKey(live?.itemKey ?? null, live?.changeId, live?.ownerKey);
  }, [
    writing,
    key,
    locationKey,
    address.itemKey,
    address.changeId,
    pinnedItem,
    pinnedChange,
    writeItemKey,
    projectId,
  ]);
}
