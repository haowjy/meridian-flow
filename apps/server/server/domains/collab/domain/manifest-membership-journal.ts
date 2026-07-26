/** Identifies branch-journal rows that only maintain project manifest membership. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { BranchJournalRow } from "./branch-push-contracts.js";

export function manifestMembershipRowDocumentId(
  row: Pick<BranchJournalRow, "updateMeta">,
): DocumentId | null {
  const meta = row.updateMeta;
  if (typeof meta !== "object" || meta === null) return null;
  const record = meta as { kind?: unknown; documentId?: unknown };
  return record.kind === "manifest_membership" && typeof record.documentId === "string"
    ? (record.documentId as DocumentId)
    : null;
}
