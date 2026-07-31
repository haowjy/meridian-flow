/**
 * The documents `@` offers in the chat composer.
 *
 * The rows are [`SuggestionList`](../../../components/app/SuggestionList.tsx),
 * the same list the manuscript's `/` and `[[` render, so a writer meets all
 * three the same way. What differs is where it hangs and what a row says.
 *
 * **It places itself, deliberately.** The manuscript's menus go through the
 * chrome kernel's popover, which is Radix measuring against the layout
 * viewport. The composer sits at the bottom of a phone screen with a keyboard
 * under it, and the layout viewport does not know the keyboard exists — so the
 * geometry here is read off `visualViewport`, which does. The menu opens
 * upward, into the transcript the writer can see, and turns downward only when
 * there is genuinely no room above.
 *
 * **The anchor is the suggestion's own rect** — TipTap's `clientRect`, read
 * fresh on every paint. It can decline to answer (a decoration mid-remount, a
 * layout that has not happened); the composer frame's top edge is then the
 * anchor of last resort. Degraded placement is the contract, a missing menu is
 * not.
 *
 * **The writer never leaves the sentence.** Nothing here is focusable and every
 * row cancels its own mousedown, because the caret is still in the composer and
 * the next keystroke has to keep filtering.
 */

import { t } from "@lingui/core/macro";
import { FileText } from "lucide-react";
import { type CSSProperties, type RefObject, useEffect, useReducer } from "react";
import { createPortal } from "react-dom";

import { SUGGESTION_MENU_SHELL, SuggestionList } from "@/components/app/SuggestionList";
import type { SuggestionMenu, SuggestionMenuSnapshot } from "@/core/completion";
import type { ReferenceDocumentItem } from "@/core/references";
import { cn } from "@/lib/utils";

/** Between the caret's line and the menu's edge, so neither sits on the other. */
const GAP = 6;

/** Clearance from the visual viewport's own edges. */
const MARGIN = 8;

/** The menu's own floor, and the width the left edge is clamped against. */
const MIN_WIDTH = 256;

/** Under this, "above the caret" is a strip nothing readable fits in. */
const MIN_ROOM = 120;

export function ComposerReferenceMenu({
  id,
  menu,
  snapshot,
  frameRef,
}: {
  /** Listbox id, and what a probe looks for. */
  id: string;
  /** Null before the editor mounts, when the snapshot is closed anyway. */
  menu: SuggestionMenu<ReferenceDocumentItem> | null;
  snapshot: SuggestionMenuSnapshot<ReferenceDocumentItem>;
  /** The composer's own box, for the anchor of last resort. */
  frameRef: RefObject<HTMLElement | null>;
}) {
  // Anything that moves the caret without changing the query re-anchors the
  // menu: the composer growing or scrolling, the transcript scrolling under
  // it, the window resizing, a phone keyboard shortening the visual viewport,
  // a webfont arriving after first paint. The rect itself is read fresh each
  // paint; these listeners only cause the paint.
  const [, remeasure] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    if (!snapshot.open) return;
    const viewport = window.visualViewport;
    const tick = () => remeasure();

    // Capture catches the composer's own internal scroll and the transcript's.
    window.addEventListener("scroll", tick, { capture: true, passive: true });
    window.addEventListener("resize", tick);
    viewport?.addEventListener("resize", tick);
    viewport?.addEventListener("scroll", tick);
    document.fonts?.ready?.then(tick).catch(() => {});

    return () => {
      window.removeEventListener("scroll", tick, { capture: true });
      window.removeEventListener("resize", tick);
      viewport?.removeEventListener("resize", tick);
      viewport?.removeEventListener("scroll", tick);
    };
  }, [snapshot.open]);

  if (!snapshot.open || !menu) return null;

  const anchor = snapshot.anchorRect?.() ?? frameAnchorRect(frameRef.current);
  if (!anchor) return null;

  return createPortal(
    <div
      data-composer-reference-menu={id}
      // Placed by hand rather than by a popper: the numbers below come from the
      // visual viewport, and floating-ui measures the layout one.
      style={place(anchor)}
      className={cn(
        SUGGESTION_MENU_SHELL,
        "fixed z-50 min-w-64 rounded-md border bg-popover text-popover-foreground shadow-md",
      )}
    >
      <SuggestionList
        id={id}
        label={snapshot.label}
        activeIndex={snapshot.activeIndex}
        onActivate={(index) => menu.setActiveIndex(index)}
        onChoose={(index) => menu.choose(index)}
        rows={snapshot.items.map((item) => ({
          key: item.key,
          content: <ReferenceRow item={item} />,
        }))}
      />
    </div>,
    document.body,
  );
}

function ReferenceRow({ item }: { item: ReferenceDocumentItem }) {
  return (
    <>
      <FileText aria-hidden />
      <span className="truncate">
        {item.name}
        {item.matchedAlias ? (
          <span className="text-ink-subtle"> {t`(also ${item.matchedAlias})`}</span>
        ) : null}
      </span>
      <span className="ml-auto shrink-0 pl-4 text-ink-subtle text-xs">
        {/* Two documents answering to one name resolve to neither, so telling
            them apart by folder would not help. The pick still works: it names
            this document by its URI instead of by the title they share. */}
        {item.ambiguous ? t`two documents share this name` : item.location}
      </span>
    </>
  );
}

/** The composer's top edge: degraded placement, never a missing menu. */
function frameAnchorRect(frame: HTMLElement | null): DOMRect | null {
  if (!frame) return null;
  const box = frame.getBoundingClientRect();
  return new window.DOMRect(box.left, box.top, box.width, 0);
}

/**
 * Above the caret when the transcript leaves room, below it when it does not,
 * and inside the visual viewport either way — which on a phone means above the
 * keyboard, because that is what shortens the visual viewport in the first
 * place.
 */
function place(anchor: DOMRect): CSSProperties {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const left = viewport?.offsetLeft ?? 0;
  const height = viewport?.height ?? window.innerHeight;
  const width = viewport?.width ?? window.innerWidth;
  const right = left + width;
  const bottom = top + height;

  const above = anchor.top - GAP - top - MARGIN;
  const below = bottom - MARGIN - (anchor.bottom + GAP);
  const upward = above >= MIN_ROOM || above >= below;

  const x = Math.max(left + MARGIN, Math.min(anchor.left, right - MARGIN - MIN_WIDTH));
  return {
    left: `${x}px`,
    maxWidth: `${Math.max(MIN_WIDTH, right - MARGIN - x)}px`,
    ...(upward
      ? {
          // `bottom` is measured from the layout viewport, which is what a
          // fixed element is positioned against even while the visual one is
          // shorter.
          bottom: `${window.innerHeight - (anchor.top - GAP)}px`,
          maxHeight: `${Math.max(0, above)}px`,
        }
      : { top: `${anchor.bottom + GAP}px`, maxHeight: `${Math.max(0, below)}px` }),
  };
}
