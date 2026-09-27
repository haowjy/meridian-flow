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
import type { SubagentRevealBlock } from "./conversation-reveal-controller";

/**
 * The subagent block to flash in a landed turn: its launch card, or by default
 * the last matching block, which is the child's latest transcript point.
 */
export function subagentBlockRevealTarget(
  row: ParentNode,
  subagentThreadId: string,
  block: SubagentRevealBlock = "latest",
): HTMLElement | undefined {
  const selector = block === "card" ? "[data-subagent-card]" : "[data-subagent-thread-id]";
  return [...row.querySelectorAll<HTMLElement>(selector)]
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
  resolveTurnId?: (
    turnId: string,
    subagentThreadId?: string,
    subagentBlock?: SubagentRevealBlock,
  ) => string;
  /** Whether the thread's history request has resolved. */
  historySettled: boolean;
  viewportRef: RefObject<HTMLElement | null>;
  scrollToIndex: (index: number) => void;
}): void {
  const request = useTurnReveal(threadId);
  const scroll = useRef(scrollToIndex);
  const resolve = useRef(resolveTurnId);
  resolve.current = resolveTurnId;
  scroll.current = scrollToIndex;

  useEffect(() => {
    if (!request) return;
    const targetTurnId =
      resolve.current?.(request.turnId, request.subagentThreadId, request.subagentBlock) ??
      request.turnId;
    const index = turns.findIndex((turn) => turn.id === targetTurnId);
    if (index < 0) {
      // Absent from a settled transcript means absent from this conversation.
      // While history is still loading, a missing turn is one yet to arrive.
      if (historySettled) request.unavailable();
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    let raf = 0;
    let flashTimer = 0;
    let cancelled = false;

    const land = () => {
      scroll.current(index);
      request.landed();
      const subagentThreadId = request.subagentThreadId;
      if (subagentThreadId) {
        const deadline = performance.now() + 5000;
        const revealBlock = () => {
          if (cancelled) return;
          const row = viewport.querySelector<HTMLElement>(
            `[data-turn-id="${CSS.escape(targetTurnId)}"]`,
          );
          const target = row
            ? subagentBlockRevealTarget(row, subagentThreadId, request.subagentBlock)
            : undefined;
          if ((!target || !row?.getBoundingClientRect().height) && performance.now() < deadline) {
            raf = requestAnimationFrame(revealBlock);
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
          flashTimer = window.setTimeout(
            () => target.classList.remove("subagent-reveal-flash"),
            900,
          );
        };
        raf = requestAnimationFrame(revealBlock);
      }
    };

    // A reveal reaches a transcript that is still parked: revealing a docked
    // chat un-collapses it in the same commit that delivers the request, and
    // this viewport is 0×0 until that lands. Centering inside a zero-height
    // scroller computes garbage, so wait for the surface to get its size.
    let observer: ResizeObserver | undefined;
    if (viewport.clientHeight > 0) {
      land();
    } else {
      observer = new ResizeObserver(() => {
        if (viewport.clientHeight === 0) return;
        observer?.disconnect();
        land();
      });
      observer.observe(viewport);
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      cancelAnimationFrame(raf);
      window.clearTimeout(flashTimer);
    };
  }, [historySettled, request, turns, viewportRef]);
}
