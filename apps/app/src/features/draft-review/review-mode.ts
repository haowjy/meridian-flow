/**
 * Review changes on one document host: which draft the page reviews, against what, the change in
 * focus, and the commands that move within it or leave it. Main reads it from its address and the
 * side from its stored slot (`features/project/use-review-mode.ts`); nothing else records whether a
 * pane is reviewing. The rows are the editor's (`ReviewChangesExtension`), lifted into the host's
 * `ReviewSurface` so the bar can count and step them.
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

/**
 * What the host's editor reads of Review changes, for the chrome above it: the rows (the stepper's
 * and "Review N changes"'s count) and whether the pane is wide enough for Side by side. One per
 * host (`useDocumentReview`), so two documents on screen keep their own.
 */
export class ReviewSurface {
  private rowsNow: readonly ReviewRow[] | null = null;
  private wideNow = false;
  /** A step back into another chapter: its review opens at its last change, not its first. */
  private landing: "last" | null = null;
  private readonly listeners = new Set<() => void>();

  get rows(): readonly ReviewRow[] | null {
    return this.rowsNow;
  }

  get wide(): boolean {
    return this.wideNow;
  }

  publishRows(rows: readonly ReviewRow[] | null): void {
    if (rows === this.rowsNow) return;
    this.rowsNow = rows;
    this.notify();
  }

  setWide(wide: boolean): void {
    if (wide === this.wideNow) return;
    this.wideNow = wide;
    this.notify();
  }

  landOnLast(): void {
    this.landing = "last";
  }

  /** Where the next chapter's review opens without a `change`, once: its first change or its last. */
  takeLanding(): "first" | "last" {
    const landing = this.landing ?? "first";
    this.landing = null;
    return landing;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const ReviewSurfaceContext = createContext<ReviewSurface | null>(null);
export const ReviewSurfaceProvider = ReviewSurfaceContext.Provider;

export function useReviewSurface(): ReviewSurface | null {
  return useContext(ReviewSurfaceContext);
}

const noSubscription = () => () => {};

/** The rows the host's editor last read; null before it has read any. */
export function useReviewRows(): readonly ReviewRow[] | null {
  const surface = useReviewSurface();
  return useSyncExternalStore(
    surface?.subscribe ?? noSubscription,
    () => surface?.rows ?? null,
    () => null,
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

/** The layout the writer chose: what the toggle shows. */
export function useChosenReviewLayout(): ReviewLayout {
  return useSyncExternalStore(layoutSubscribers.subscribe, readLayout, () => "inline");
}

/** Whether the host's pane is wide enough for two columns; a narrow one offers Inline only. */
export function useReviewFitsSide(): boolean {
  const surface = useReviewSurface();
  return useSyncExternalStore(
    surface?.subscribe ?? noSubscription,
    () => surface?.wide ?? false,
    () => false,
  );
}

/** The layout the page shows: Side by side only where it was chosen and the pane fits it. */
export function useReviewLayout(): ReviewLayout {
  const chosen = useChosenReviewLayout();
  return useReviewFitsSide() ? chosen : "inline";
}
