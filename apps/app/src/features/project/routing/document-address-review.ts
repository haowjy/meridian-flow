import { type DraftOwnerKey, draftOwnerKey } from "@meridian/contracts/branches";

/**
 * Whose draft an item reviews: the owner the address names. A hidden create can name its item
 * without the address, and then it is the Work scope's draft. Null while the scope is unresolved,
 * or when there is no item.
 */
export function addressReviewOwner(
  address: { itemKey?: string; owner?: DraftOwnerKey },
  scopeWorkId: string | null,
): DraftOwnerKey | null {
  if (!address.itemKey) return null;
  if (address.owner) return address.owner;
  return scopeWorkId ? draftOwnerKey({ kind: "work", workId: scopeWorkId }) : null;
}
