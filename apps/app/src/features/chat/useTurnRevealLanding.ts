/**
 * Turn stage of a conversation reveal, inside the virtualized transcript.
 *
 * The transcript owns this stage and always reports it: it lands the named turn
 * or, once its history has settled without that turn, hands the writer back to
 * the thread the shell already brought them to.
 *
 * `TurnList` stays the single scroll owner — this hook receives the one
 * capability it needs (`scrollToIndex`) rather than reaching for the viewport's
 * scroll itself.
 */
import { type RefObject, useEffect, useRef } from "react";
import { useTurnReveal } from "./conversation-reveal";

/** The last matching block in a landed turn is the child's latest transcript point. */
export function latestSubagentBlockRevealTarget(
  row: ParentNode,
  subagentThreadId: string,
): HTMLElement | undefined {
  return [...row.querySelectorAll<HTMLElement>("[data-subagent-thread-id]")]
    .filter((element) => element.dataset.subagentThreadId === subagentThreadId)
    .at(-1);
}

export function useTurnRevealLanding({
  threadId,
  turns,
  resolveTurnId,
  historySettled,
  viewportRef,
  scrollToIndex,
}: {
  threadId: string;
  /** Rows in render order — the turns this transcript can actually land on. */
  turns: readonly { id: string }[];
  /** Transcript data can redirect a block-level reveal beyond its origin turn. */
  resolveTurnId?: (turnId: string, subagentThreadId?: string) => string;
  /** Whether the thread's history request has resolved. */
  historySettled: boolean;
  viewportRef: RefObject<HTMLElement | null>;
  scrollToIndex: (index: number) => void;
}): void {
  const request = useTurnReveal(threadId);
  const scroll = useRef(scrollToIndex);
  scroll.current = scrollToIndex;

  useEffect(() => {
    if (!request) return;
    const targetTurnId =
      resolveTurnId?.(request.turnId, request.subagentThreadId) ?? request.turnId;
    const index = turns.findIndex((turn) => turn.id === targetTurnId);
    if (index < 0) {
      // Absent from a settled transcript means absent from this conversation.
      // While history is still loading, a missing turn is one yet to arrive.
      if (historySettled) request.unavailable();
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;

    const land = () => {
      scroll.current(index);
      request.landed();
      const subagentThreadId = request.subagentThreadId;
      if (subagentThreadId) {
        let attempts = 0;
        const revealBlock = () => {
          const row = viewport.querySelector<HTMLElement>(
            `[data-turn-id="${CSS.escape(targetTurnId)}"]`,
          );
          const target = row ? latestSubagentBlockRevealTarget(row, subagentThreadId) : undefined;
          if (!target && attempts++ < 12) {
            requestAnimationFrame(revealBlock);
            return;
          }
          if (!target) return;
          target.scrollIntoView({
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "auto"
              : "smooth",
            block: "center",
          });
          target.classList.add("subagent-reveal-flash");
          window.setTimeout(() => target.classList.remove("subagent-reveal-flash"), 900);
        };
        requestAnimationFrame(revealBlock);
      }
    };

    // A reveal reaches a transcript that is still parked: revealing a docked
    // chat un-collapses it in the same commit that delivers the request, and
    // this viewport is 0×0 until that lands. Centering inside a zero-height
    // scroller computes garbage, so wait for the surface to get its size.
    if (viewport.clientHeight > 0) {
      land();
      return;
    }
    const observer = new ResizeObserver(() => {
      if (viewport.clientHeight === 0) return;
      observer.disconnect();
      land();
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [historySettled, request, resolveTurnId, turns, viewportRef]);
}
