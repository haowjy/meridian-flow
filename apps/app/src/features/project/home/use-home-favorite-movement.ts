/** Preserves scroll geometry and keyboard focus across explicit card-movement commits. */
import { useLayoutEffect, useRef, useState } from "react";

export type HomeMovementToken = {
  threadId: string;
  anchorId?: string;
  anchorTop: number;
  originTop: number;
  scrollTop: number;
  keyboard: boolean;
};

export function useHomeFavoriteMovement() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<HomeMovementToken | null>(null);
  const capture = (threadId: string, keyboard: boolean): HomeMovementToken | null => {
    const scroll = scrollRef.current;
    if (!scroll) return null;
    const bounds = scroll.getBoundingClientRect();
    const cards = [...scroll.querySelectorAll<HTMLElement>("[data-home-card]")];
    const origin = cards.find((card) => card.dataset.homeCard === threadId);
    const anchor = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      return card !== origin && rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    return {
      threadId,
      anchorId: anchor?.dataset.homeCard,
      anchorTop: anchor?.getBoundingClientRect().top ?? 0,
      originTop: origin?.getBoundingClientRect().top ?? bounds.top,
      scrollTop: scroll.scrollTop,
      keyboard,
    };
  };
  const commit = (token: HomeMovementToken | null) => {
    if (token) setPending(token);
  };

  useLayoutEffect(() => {
    const move = pending;
    const scroll = scrollRef.current;
    if (!move || !scroll) return;
    const cards = [...scroll.querySelectorAll<HTMLElement>("[data-home-card]")];
    const anchor = move.anchorId
      ? (cards.find((card) => card.dataset.homeCard === move.anchorId) ?? null)
      : null;
    if (anchor) scroll.scrollTop += anchor.getBoundingClientRect().top - move.anchorTop;
    else
      scroll.scrollTop = Math.min(
        move.scrollTop,
        Math.max(0, scroll.scrollHeight - scroll.clientHeight),
      );

    if (move.keyboard) {
      const bounds = scroll.getBoundingClientRect();
      const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      };
      const destination = [...scroll.querySelectorAll<HTMLElement>("[data-home-favorite]")].find(
        (control) => control.dataset.homeFavorite === move.threadId,
      );
      const survivors = [...scroll.querySelectorAll<HTMLElement>("[data-home-card] button")]
        .filter(
          (control) =>
            control.closest<HTMLElement>("[data-home-card]")?.dataset.homeCard !== move.threadId,
        )
        .filter(visible)
        .sort(
          (a, b) =>
            Math.abs(a.getBoundingClientRect().top - move.originTop) -
            Math.abs(b.getBoundingClientRect().top - move.originTop),
        );
      const heading = [...scroll.querySelectorAll<HTMLElement>("h2")].find(visible);
      const target =
        destination && visible(destination) ? destination : (survivors[0] ?? heading ?? scroll);
      const temporary = target === heading || target === scroll;
      const previousTabIndex = temporary ? target.getAttribute("tabindex") : null;
      if (temporary) target.tabIndex = -1;
      target.focus({ preventScroll: true });
      if (temporary) {
        if (previousTabIndex === null) target.removeAttribute("tabindex");
        else target.setAttribute("tabindex", previousTabIndex);
      }
    }
    setPending(null);
  }, [pending]);
  return { scrollRef, capture, commit };
}
