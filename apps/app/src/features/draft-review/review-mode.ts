import { createContext, useContext, useSyncExternalStore } from "react";
import { browserStorage } from "@/client/storage/browser-record";
import type { ReviewRow } from "@/core/editor/extensions/review-changes/review-rows";
import type { PanePlace } from "@/features/project/pane-place";
import { createPreferenceSubscribers } from "@/lib/preference-subscribers";

export type ReviewTarget = "live" | `file:${string}` | (string & {});

export type ReviewMode = {
  projectId: string;
  documentId: string;
  draftId: string;
  itemKey: string;
  target: ReviewTarget;
  changeId: string | null;
  listed: boolean | null;
  close: () => void;
  focus: (changeId: string) => void;
  retarget: (target: ReviewTarget) => void;
};

export type DraftPage = { projectId: string; documentId: string; draftId: string; itemKey: string };
const DraftPageContext = createContext<DraftPage | null>(null);
export const DraftPageProvider = DraftPageContext.Provider;

export function useDraftPage(): DraftPage | null {
  return useContext(DraftPageContext);
}

const ReviewModeContext = createContext<ReviewMode | null>(null);
export const ReviewModeProvider = ReviewModeContext.Provider;

export function useReviewMode(): ReviewMode | null {
  return useContext(ReviewModeContext);
}

const landingOnLast = new Map<PanePlace, string>();

export function landOnLast(pane: PanePlace, documentId: string): void {
  landingOnLast.set(pane, documentId);
}

export function landingOf(pane: PanePlace, documentId: string): "first" | "last" {
  return landingOnLast.get(pane) === documentId ? "last" : "first";
}

export function landed(pane: PanePlace, documentId: string): void {
  if (landingOnLast.get(pane) === documentId) landingOnLast.delete(pane);
}

export class ReviewSurface {
  private rowsNow: readonly ReviewRow[] | null = null;
  private wideNow = false;
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

export function useReviewRows(): readonly ReviewRow[] | null {
  const surface = useReviewSurface();
  return useSyncExternalStore(
    surface?.subscribe ?? noSubscription,
    () => surface?.rows ?? null,
    () => null,
  );
}

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

export function useChosenReviewLayout(): ReviewLayout {
  return useSyncExternalStore(layoutSubscribers.subscribe, readLayout, () => "inline");
}

export function useReviewFitsSide(): boolean {
  const surface = useReviewSurface();
  return useSyncExternalStore(
    surface?.subscribe ?? noSubscription,
    () => surface?.wide ?? false,
    () => false,
  );
}

export function useReviewLayout(): ReviewLayout {
  const chosen = useChosenReviewLayout();
  return useReviewFitsSide() ? chosen : "inline";
}
