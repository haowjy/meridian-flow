/** The owner key a draft surface reads and commands: a Work's, or for a chat with no Work its lineage's. */
import { type DraftOwnerKey, draftOwnerKey } from "@meridian/contracts/branches";

/** `work:<id>`, or "" for a surface with no Work (its queries stay disabled). */
export function workOwnerKey(work: { id: string } | null): DraftOwnerKey | "" {
  return work ? draftOwnerKey({ kind: "work", workId: work.id }) : "";
}

/**
 * A chat's drafts: its lineage's when it has no Work (the No Work row), else its Work's.
 * "" until a chat with no Work knows its lineage root.
 */
export function chatOwnerKey(
  work: { id: string; isNoWork: boolean } | null,
  rootThreadId: string | null,
): DraftOwnerKey | "" {
  if (!work) return "";
  if (!work.isNoWork) return workOwnerKey(work);
  return rootThreadId ? draftOwnerKey({ kind: "lineage", rootThreadId }) : "";
}
