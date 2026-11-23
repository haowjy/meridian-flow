/**
 * Review changes on one document host: which draft the page reviews, against what, the change in
 * focus, and the commands that move within it or leave it. Main reads it from its address and the
 * side from its stored slot (`features/project/use-review-mode.ts`); nothing else records whether a
 * pane is reviewing. The rows are the editor's (`ReviewChangesExtension`), lifted here so the bar
 * can count and step them.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import { browserStorage } from "@/client/storage/browser-record";
import type { ReviewRow } from "@/core/editor/extensions/review-changes/review-rows";
import { createPreferenceSubscribers } from "@/lib/preference-subscribers";

/** What Review changes compares the draft against: Live, another draft by id, or another file. */
export type ReviewTarget = "live" | `file:${string}` | (string & {});

export type ReviewMode = {
  projectId: string;
  documentId: string;
  draftId: string;
  itemKey: string;
  target: ReviewTarget;
  /** The change in focus; null until one is. */
  changeId: string | null;
  /**
   * The draft's list says the document has a change to review (`DraftItem.pending`); null while
   * it loads. An empty read of a copy still syncing waits on it rather than close.
   */
  listed: boolean | null;
  close: () => void;
  focus: (changeId: string) => void;
  retarget: (target: ReviewTarget) => void;
};

/** The draft a page shows, plain or in Review changes; null on Live. */
export type DraftPage = { projectId: string; documentId: string; draftId: string; itemKey: string };
const DraftPageContext = createContext<DraftPage | null>(null);
export const DraftPageProvider = DraftPageContext.Provider;

export function useDraftPage(): DraftPage | null {
  return useContext(DraftPageContext);
}

const ReviewModeContext = createContext<ReviewMode | null>(null);
export const ReviewModeProvider = ReviewModeContext.Provider;

/** The host's Review changes, or null on Live and on a plain draft. */
export function useReviewMode(): ReviewMode | null {
  return useContext(ReviewModeContext);
}

/** The rows the editor last read, by document: what the bar's stepper counts. */
const rowsByDocument = new Map<string, readonly ReviewRow[]>();
const rowListeners = new Set<() => void>();
const NO_ROWS: readonly ReviewRow[] = [];

export function publishReviewRows(documentId: string, rows: readonly ReviewRow[] | null): void {
  if (rows) rowsByDocument.set(documentId, rows);
  else rowsByDocument.delete(documentId);
  for (const listener of rowListeners) listener();
}

export function useReviewRows(documentId: string): readonly ReviewRow[] | null {
  return useSyncExternalStore(
    (listener) => {
      rowListeners.add(listener);
      return () => rowListeners.delete(listener);
    },
    () => rowsByDocument.get(documentId) ?? null,
    () => NO_ROWS,
  );
}

/** Inline or Side by side: a device preference, not in the address. */
export type ReviewLayout = "inline" | "side";
const LAYOUT_KEY = "meridian:review-layout";
const layoutSubscribers = createPreferenceSubscribers(LAYOUT_KEY, () => {});

function readLayout(): ReviewLayout {
  return browserStorage("local")?.getItem(LAYOUT_KEY) === "side" ? "side" : "inline";
}

export function setReviewLayout(layout: ReviewLayout): void {
  browserStorage("local")?.setItem(LAYOUT_KEY, layout);
  layoutSubscribers.notify();
}

export function useReviewLayout(): ReviewLayout {
  return useSyncExternalStore(layoutSubscribers.subscribe, readLayout, () => "inline");
}
