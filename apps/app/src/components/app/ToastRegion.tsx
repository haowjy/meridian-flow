/**
 * ToastRegion: the app-wide "Activity" region that stacks the toasts owners
 * register in the `ToastRegistry`. It knows nothing about what a toast is for.
 *
 * Desktop: the window's bottom-right corner, 352px wide, stacking upward with
 * the newest at the bottom. At most three are expanded; older ones fold into a
 * "+N more" row above that reveals them all. Below the toasts sits the notice
 * host, where the open project's Undo notices (delete, move, copy) portal in
 * (`project-notices.tsx`), so every desktop notice shares this one corner.
 * When the corner would cover a pinned chat composer (its column reaches the
 * right edge once the right panel is closed), the region rises above it
 * (`useToastClearance`): the send button stays reachable.
 *
 * Phone (coarse pointer, narrow): one compact bar at the top under the top bar
 * showing the toast's title and bar (several running toasts become "N in
 * progress" with a combined bar). Tapping it opens a bottom sheet holding each
 * card with its controls. The bottom stays free for the composer, the keyboard
 * and the change bar.
 *
 * Toasts never take focus when they appear. The region reports which toasts it
 * is showing, while the tab is visible, back to the registry so an owner can
 * tell a toast was actually seen (`useToastVisible`).
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChevronUp, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { PersistentToast, ToastBar } from "@/components/ui/persistent-toast";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { cn } from "@/lib/utils";
import {
  type ActivityToast,
  useToastRegionLayout,
  useToastRegistry,
  useToastSnapshot,
} from "./toast-registry";

const MAX_EXPANDED = 3;
/** The region's inset from the window's right and bottom edges, in px. */
const EDGE = 16;

function subscribeTabVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function useTabVisible(): boolean {
  return useSyncExternalStore(
    subscribeTabVisibility,
    () => document.visibilityState === "visible",
    () => false,
  );
}

/** The one bar standing for several running toasts: their mean, or indeterminate when none has a number. */
function combinedProgress(running: readonly ActivityToast[]): number | "indeterminate" {
  const values = running.flatMap((toast) =>
    typeof toast.progress === "number" ? [toast.progress] : [],
  );
  return values.length === 0
    ? "indeterminate"
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function ToastRegion() {
  const registry = useToastRegistry();
  const { setHost, clearances } = useToastRegionLayout();
  const desktopRegion = useRef<HTMLElement>(null);
  const [lift, setLift] = useState(EDGE);
  const { toasts, collapsed, revealRequest } = useToastSnapshot();
  const phone = usePhoneShell();
  const tabVisible = useTabVisible();
  const [showAll, setShowAll] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const handledReveal = useRef(revealRequest);
  useEffect(() => {
    if (revealRequest === handledReveal.current) return;
    handledReveal.current = revealRequest;
    if (phone) setSheetOpen(true);
  }, [revealRequest, phone]);

  useEffect(() => {
    if (toasts.length === 0) setSheetOpen(false);
  }, [toasts.length]);

  const newest = toasts.at(-1);
  const running = toasts.filter((toast) => toast.progress !== undefined);
  const summarized = running.length >= 2;
  const open = phone === true && sheetOpen;

  // What is on screen as itself: a card, collapsed or not. A toast folded into
  // "+N more" or "N in progress" has not been seen.
  const shown: readonly ActivityToast[] =
    phone === null
      ? []
      : phone
        ? open
          ? toasts
          : newest && !summarized
            ? [newest]
            : []
        : showAll
          ? toasts
          : toasts.slice(-MAX_EXPANDED);
  const shownKeys = shown.map((toast) => toast.key).join("\n");
  useEffect(() => {
    registry.reportVisible(new Set(tabVisible && shownKeys ? shownKeys.split("\n") : []));
    return () => registry.reportVisible(new Set());
  }, [registry, shownKeys, tabVisible]);

  // Rises above any cleared element it would overlap. Observing each element's ancestors
  // catches what moves it sideways without resizing it (the right panel opening).
  useLayoutEffect(() => {
    const region = desktopRegion.current;
    if (!region) return;
    const measure = () => {
      const left = window.innerWidth - EDGE - region.offsetWidth;
      let next = EDGE;
      for (const element of clearances) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.right <= left || box.bottom < window.innerHeight / 2) continue;
        next = Math.max(next, window.innerHeight - box.top + EDGE / 2);
      }
      setLift(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(region);
    for (const element of clearances)
      for (let node: Element | null = element; node; node = node.parentElement)
        observer.observe(node);
    return () => observer.disconnect();
  }, [clearances, phone]);

  if (phone === null) return null;

  if (phone) {
    if (!newest) return null;
    const others = toasts.length - 1;
    return (
      <section aria-label={t`Activity`}>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          className="focus-ring activity-phone-bar fixed z-40 flex min-h-11 items-center gap-3 rounded-lg border border-border-subtle bg-card px-3 text-left text-sm text-card-foreground shadow-card animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none"
        >
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {summarized ? <Trans>{running.length} in progress</Trans> : newest.title}
          </span>
          {!summarized && others > 0 ? (
            <span className="shrink-0 text-caption text-ink-muted">+{others}</span>
          ) : null}
          {summarized ? (
            <ToastBar
              progress={combinedProgress(running)}
              label={t`Combined progress`}
              className="h-1 w-20 shrink-0"
            />
          ) : newest.progress !== undefined ? (
            <ToastBar
              progress={newest.progress}
              label={newest.title}
              className="h-1 w-20 shrink-0"
            />
          ) : null}
          <ChevronUp aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
        <Sheet open={open} onOpenChange={setSheetOpen}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="max-h-[78svh] gap-0 rounded-t-2xl border-border-subtle p-0"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
            <div className="flex shrink-0 items-center gap-2 pl-4 pr-1">
              <SheetTitle className="min-w-0 flex-1 truncate text-sm">
                <Trans>Activity</Trans>
              </SheetTitle>
              <PhoneIconButton aria-label={t`Close`} onClick={() => setSheetOpen(false)}>
                <X className="size-5" aria-hidden />
              </PhoneIconButton>
            </div>
            <SheetDescription className="sr-only">
              <Trans>What is running in the background, with its controls.</Trans>
            </SheetDescription>
            <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain px-2 pb-3">
              {[...toasts].reverse().map(({ key, ...spec }) => (
                <li key={key}>
                  <PersistentToast {...spec} touch />
                </li>
              ))}
            </ul>
          </SheetContent>
        </Sheet>
      </section>
    );
  }

  const hidden = toasts.length - shown.length;
  const canFold = toasts.length > MAX_EXPANDED;
  return (
    <section
      ref={desktopRegion}
      aria-label={t`Activity`}
      style={{ bottom: lift, maxHeight: showAll ? `calc(100svh - ${lift + EDGE}px)` : undefined }}
      className={cn(
        "pointer-events-none fixed right-4 z-40 flex w-88 max-w-[calc(100vw-2rem)] flex-col gap-2",
        // Scrolling clips a card's shadow at the region edge, so the long list drops it.
        showAll && "overflow-y-auto [&_article]:shadow-none",
      )}
    >
      {canFold ? (
        <button
          type="button"
          onClick={() => setShowAll((all) => !all)}
          className="focus-ring pointer-events-auto self-start rounded-md bg-card px-2.5 py-1 text-caption text-ink-muted shadow-card hover:text-foreground"
        >
          {hidden > 0 ? <Trans>+{hidden} more</Trans> : <Trans>Show fewer</Trans>}
        </button>
      ) : null}
      <ul className="flex flex-col gap-2 empty:hidden">
        {shown.map(({ key, ...spec }) => (
          <li
            key={key}
            className="pointer-events-auto animate-in fade-in-0 slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
          >
            <PersistentToast
              {...spec}
              collapsed={collapsed.has(key)}
              onCollapsedChange={(next) => registry.setCollapsed(key, next)}
            />
          </li>
        ))}
      </ul>
      <div
        ref={setHost}
        className="pointer-events-auto flex flex-col gap-2 empty:hidden [&>*]:animate-in [&>*]:fade-in-0 [&>*]:slide-in-from-bottom-2 [&>*]:duration-200 motion-reduce:[&>*]:animate-none"
      />
    </section>
  );
}
