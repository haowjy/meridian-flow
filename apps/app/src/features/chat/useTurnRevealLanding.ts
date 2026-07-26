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

export function useTurnRevealLanding({
  threadId,
  turns,
  historySettled,
  viewportRef,
  scrollToIndex,
}: {
  threadId: string;
  /** Rows in render order — the turns this transcript can actually land on. */
  turns: readonly { id: string }[];
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
    const index = turns.findIndex((turn) => turn.id === request.turnId);
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
  }, [historySettled, request, turns, viewportRef]);
}
