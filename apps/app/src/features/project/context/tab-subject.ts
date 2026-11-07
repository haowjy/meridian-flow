/** What dragging a tab, or the leaf crumb of its path, names. */
import type { CopyContextEntryView } from "@meridian/contracts/protocol";
import { type ContextTab, isDraftOnly } from "@/client/stores";
import type { ReferenceSubject } from "./entry-drag/reference-source";

/**
 * A tab's document, read as the tab shows it: the draft while the tab is under review, else the
 * live document. A local or draft-only document is no placed entry a drop could act on, and a
 * reviewed document with no draft text to copy names nothing.
 */
export function tabSubject(
  tab: ContextTab,
  review: { reviewing: boolean; view: CopyContextEntryView | null },
): ReferenceSubject | null {
  if (tab.kind === "new" || isDraftOnly(tab)) return null;
  if (review.reviewing && !review.view) return null;
  return {
    ref: { kind: "file", id: tab.documentId },
    name: tab.name,
    ...(review.view ? { view: review.view } : {}),
  };
}
