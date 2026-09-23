/** Preserves scroll geometry and keyboard focus across explicit row-movement commits. */
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
  const keyboardActivation = useRef(false);
  const [pending, setPending] = useState<HomeMovementToken | null>(null);
  const capture = (
    threadId: string,
    keyboard = keyboardActivation.current,
  ): HomeMovementToken | null => {
    const scroll = scrollRef.current;
    if (!scroll) return null;
    const bounds = scroll.getBoundingClientRect();
    const rows = [...scroll.querySelectorAll<HTMLElement>("[data-project-chat-row]")];
    const origin = rows.find((row) => row.dataset.projectChatRow === threadId);
    const anchor = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return row !== origin && rect.bottom > bounds.top && rect.top < bounds.bottom;
    });
    return {
      threadId,
      anchorId: anchor?.dataset.projectChatRow,
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
    const rows = [...scroll.querySelectorAll<HTMLElement>("[data-project-chat-row]")];
    const anchor = move.anchorId
      ? (rows.find((row) => row.dataset.projectChatRow === move.anchorId) ?? null)
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
      const destination = [
        ...scroll.querySelectorAll<HTMLElement>("[data-project-chat-row-actions]"),
      ].find((control) => control.dataset.projectChatRowActions === move.threadId);
      const survivors = [...scroll.querySelectorAll<HTMLElement>("[data-project-chat-row] button")]
        .filter(
          (control) =>
            control.closest<HTMLElement>("[data-project-chat-row]")?.dataset.projectChatRow !==
            move.threadId,
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
  return {
    scrollRef,
    capture,
    commit,
    interactionProps: {
      onKeyDownCapture: () => {
        keyboardActivation.current = true;
      },
      onPointerDownCapture: () => {
        keyboardActivation.current = false;
      },
    },
  };
}
