import { type DraftId, parseDraftItemKey } from "@meridian/contracts";

/** The draft an item reviews: its key names it. Null when there is no item. */
export function addressDraftOwner(address: { itemKey?: string }): DraftId | null {
  return address.itemKey ? (parseDraftItemKey(address.itemKey)?.draftId ?? null) : null;
}
