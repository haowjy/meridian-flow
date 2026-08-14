/** Preserves the reader's scroll anchor and modality-appropriate focus across card moves. */
import { useLayoutEffect, useRef } from "react";

export function useHomeFavoriteMovement(dependency: unknown) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pending = useRef<
    | {
        threadId: string;
        anchorId?: string;
        top: number;
        scrollTop: number;
        keyboard: boolean;
      }
    | undefined
  >(undefined);
  const capture = (threadId: string, keyboard: boolean) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const bounds = scroll.getBoundingClientRect();
    const anchor = [...scroll.querySelectorAll<HTMLElement>("[data-home-card]")].find((card) => {
      const rect = card.getBoundingClientRect();
      return (
        card.dataset.homeCard !== threadId && rect.bottom > bounds.top && rect.top < bounds.bottom
      );
    });
    pending.current = {
      threadId,
      anchorId: anchor?.dataset.homeCard,
      top: anchor?.getBoundingClientRect().top ?? 0,
      scrollTop: scroll.scrollTop,
      keyboard,
    };
  };
  useLayoutEffect(() => {
    const move = pending.current;
    const scroll = scrollRef.current;
    if (!move || !scroll) return;
    const anchor = move.anchorId
      ? scroll.querySelector<HTMLElement>(`[data-home-card="${CSS.escape(move.anchorId)}"]`)
      : null;
    scroll.scrollTop = anchor
      ? scroll.scrollTop + anchor.getBoundingClientRect().top - move.top
      : move.scrollTop;
    if (move.keyboard) {
      const bounds = scroll.getBoundingClientRect();
      const controls = [
        ...scroll.querySelectorAll<HTMLElement>(
          "[data-home-favorite], [data-home-card] button, h2",
        ),
      ];
      const destination = scroll.querySelector<HTMLElement>(
        `[data-home-favorite="${CSS.escape(move.threadId)}"]`,
      );
      const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      };
      const target =
        destination && visible(destination) ? destination : (controls.find(visible) ?? scroll);
      if (target === scroll && !scroll.hasAttribute("tabindex")) scroll.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    pending.current = undefined;
  }, [dependency]);
  return { scrollRef, capture };
}
