import { type DraftId, parseDraftItemKey } from "@meridian/contracts";

export function addressDraftOwner(address: { itemKey?: string }): DraftId | null {
  return address.itemKey ? (parseDraftItemKey(address.itemKey)?.draftId ?? null) : null;
}
