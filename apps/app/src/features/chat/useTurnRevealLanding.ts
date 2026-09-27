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
import { revealSubagentDisclosure } from "./subagent/DisclosureStore";

/**
 * The subagent block to flash in a landed turn: its launch card, or by default
 * the last matching block, which is the child's latest transcript point.
 */
export function subagentBlockRevealTarget(
  row: ParentNode,
  subagentThreadId: string,
  block: SubagentRevealBlock = "latest",
): HTMLElement | undefined {
  const selector =
    block === "card"
      ? "[data-subagent-card]"
      : "[data-subagent-thread-id], [data-subagent-thread-ids]";
  return [...row.querySelectorAll<HTMLElement>(selector)]
    .filter(
      (element) =>
        element.dataset.subagentThreadId === subagentThreadId ||
        element.dataset.subagentThreadIds?.split(" ").includes(subagentThreadId),
    )
    .at(-1);
}

/** A smooth scroll to the block settles within this window before it flashes. */
const REVEAL_SCROLL_SETTLE_MS = 450;
/** Matches `subagent-block-reveal` in globals.css. */
const REVEAL_FLASH_MS = 1600;

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
  const blockReveal = useRef<(() => void) | null>(null);
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

    const land = () => {
      scroll.current(index);
      // Landing settles the request, which re-runs this effect; the block
      // flash therefore runs outside the effect so that cleanup can't cancel it.
      request.landed();
      if (request.subagentThreadId) {
        blockReveal.current?.();
        blockReveal.current = revealSubagentBlock({
          viewport,
          turnId: targetTurnId,
          subagentThreadId: request.subagentThreadId,
          block: request.subagentBlock,
        });
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
    return () => observer?.disconnect();
  }, [historySettled, request, turns, viewportRef]);

  useEffect(() => () => blockReveal.current?.(), []);
}

/**
 * Finds the subagent block once its turn has rendered, opens its disclosure,
 * scrolls it into view, and flashes it after the scroll settles. Returns a
 * cancel for a newer reveal or unmount.
 */
function revealSubagentBlock({
  viewport,
  turnId,
  subagentThreadId,
  block,
}: {
  viewport: HTMLElement;
  turnId: string;
  subagentThreadId: string;
  block?: SubagentRevealBlock;
}): () => void {
  let raf = 0;
  let timer = 0;
  let flashed: HTMLElement | null = null;
  const deadline = performance.now() + 5000;
  const find = () => {
    const row = viewport.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
    const target = row ? subagentBlockRevealTarget(row, subagentThreadId, block) : undefined;
    if ((!target || !row?.getBoundingClientRect().height) && performance.now() < deadline) {
      raf = requestAnimationFrame(find);
      return;
    }
    if (!target) return;
    const disclosureKey = target.dataset.subagentDisclosureKey;
    if (block !== "card" && disclosureKey) revealSubagentDisclosure(disclosureKey);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    // Flash once the block has arrived: started during a smooth scroll, most
    // of the flash would play while the block is still sliding in.
    const flash = () => {
      flashed = target;
      target.classList.add("subagent-reveal-flash");
      timer = window.setTimeout(() => {
        target.classList.remove("subagent-reveal-flash");
        flashed = null;
      }, REVEAL_FLASH_MS);
    };
    if (reducedMotion) flash();
    else timer = window.setTimeout(flash, REVEAL_SCROLL_SETTLE_MS);
  };
  raf = requestAnimationFrame(find);
  return () => {
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    flashed?.classList.remove("subagent-reveal-flash");
  };
}
