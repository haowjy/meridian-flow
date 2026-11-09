/**
 * Write's URL and the selected tab's review pin, kept in step. An address arriving (a review link,
 * Back to a review) is a command: it sets the tab's pin, or clears it when the address names no
 * review. After that the tab is the owner and the URL follows it, so a pin the writer changes (a
 * Live choice, the focused change) rewrites the address in place.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { tabKey, useContextTabsStore } from "@/client/stores";
import type { OpenDocumentTab } from "./open-documents";
import { type ReviewAddressAdmission, reviewAddress } from "./presented-document";

export function useReviewAddressSync({
  projectId,
  selected,
  writing,
  locationKey,
  editorWorkId,
  address,
  writeItemKey,
}: {
  projectId: string;
  selected: OpenDocumentTab | null;
  /** Write on a desktop: the only place the address carries a review. */
  writing: boolean;
  locationKey: string | undefined;
  editorWorkId: string | null;
  address: {
    itemKey: string | undefined;
    changeId: string | undefined;
    /** The document the address resolved to. */
    documentId: string | undefined;
    admission: ReviewAddressAdmission | undefined;
  };
  writeItemKey: (itemKey: string | null, changeId?: string) => void;
}) {
  /** The history entry whose address the tab has taken in. */
  const arrived = useRef<string | undefined>(undefined);
  const key = selected ? tabKey(selected.tab) : null;
  const documentId = selected?.tab.documentId;
  const pin = selected?.tab.reviewPin;

  useLayoutEffect(() => {
    if (!writing || key === null || locationKey === undefined || arrived.current === locationKey)
      return;
    if (address.documentId !== documentId) return;
    if (address.itemKey && (address.admission !== "admitted" || !editorWorkId)) return;
    arrived.current = locationKey;
    const next =
      address.itemKey && editorWorkId
        ? reviewAddress(editorWorkId, address.itemKey, address.changeId)
        : null;
    if (
      next?.owner === pin?.owner &&
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
  }, [writing, key, documentId, locationKey, editorWorkId, address, pin, projectId]);

  const pinnedItem = pin?.itemKey ?? null;
  const pinnedChange = pin?.changeId;
  useEffect(() => {
    if (!writing || key === null || arrived.current !== locationKey) return;
    if ((address.itemKey ?? null) === pinnedItem && address.changeId === pinnedChange) return;
    writeItemKey(pinnedItem, pinnedChange);
  }, [
    writing,
    key,
    locationKey,
    address.itemKey,
    address.changeId,
    pinnedItem,
    pinnedChange,
    writeItemKey,
  ]);
}
