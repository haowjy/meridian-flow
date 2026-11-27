import type { CopyContextEntryView } from "@meridian/contracts/protocol";
import type { OpenDocument } from "@/client/stores";
import type { ReferenceSubject } from "./entry-drag/reference-source";

export function tabSubject(
  tab: OpenDocument,
  review: { reviewing: boolean; view: CopyContextEntryView | null },
): ReferenceSubject | null {
  if (tab.kind === "new") return null;
  if (review.reviewing && !review.view) return null;
  return {
    ref: { kind: "file", id: tab.documentId },
    name: tab.name,
    ...(review.view ? { view: review.view } : {}),
  };
}
