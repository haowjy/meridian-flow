import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { useTurnReveal } from "./conversation-reveal";
import type { SubagentRevealBlock } from "./conversation-reveal-controller";
import { revealSubagentDisclosure } from "./subagent/DisclosureStore";

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

export function toolCallRevealTarget(row: ParentNode, toolCallId: string): HTMLElement | undefined {
  const exact = [...row.querySelectorAll<HTMLElement>("[data-tool-call-id]")].find(
    (element) => element.dataset.toolCallId === toolCallId,
  );
  if (exact && !exact.closest('[data-process-fold][aria-hidden="true"]')) return exact;
  return [...row.querySelectorAll<HTMLElement>("[data-tool-call-ids]")].find((element) =>
    element.dataset.toolCallIds?.split(" ").includes(toolCallId),
  );
}

const REVEAL_SCROLL_SETTLE_MS = 450;
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
  turns: readonly { id: string }[];
  resolveTurnId?: (
    turnId: string,
    subagentThreadId?: string,
    subagentBlock?: SubagentRevealBlock,
  ) => string;
  historySettled: boolean;
  viewportRef: RefObject<HTMLElement | null>;
  scrollToIndex: (index: number) => void;
}): void {
  const request = useTurnReveal(threadId);
  const scroll = useRef(scrollToIndex);
  const resolve = useRef(resolveTurnId);
  const blockReveal = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    resolve.current = resolveTurnId;
    scroll.current = scrollToIndex;
  }, [resolveTurnId, scrollToIndex]);

  useEffect(() => {
    if (!request) return;
    const targetTurnId =
      resolve.current?.(request.turnId, request.subagentThreadId, request.subagentBlock) ??
      request.turnId;
    const index = turns.findIndex((turn) => turn.id === targetTurnId);
    if (index < 0) {
      if (historySettled) request.unavailable();
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) return;

    const land = () => {
      scroll.current(index);
      request.landed();
      const { subagentThreadId, subagentBlock, toolCallId } = request;
      if (subagentThreadId) {
        blockReveal.current?.();
        blockReveal.current = revealBlock({
          viewport,
          turnId: targetTurnId,
          locate: (row) => subagentBlockRevealTarget(row, subagentThreadId, subagentBlock),
          prepare: (target) => {
            const disclosureKey = target.dataset.subagentDisclosureKey;
            if (subagentBlock !== "card" && disclosureKey) revealSubagentDisclosure(disclosureKey);
          },
        });
      } else if (toolCallId) {
        blockReveal.current?.();
        blockReveal.current = revealBlock({
          viewport,
          turnId: targetTurnId,
          locate: (row) => toolCallRevealTarget(row, toolCallId),
        });
      }
    };

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

function revealBlock({
  viewport,
  turnId,
  locate,
  prepare,
}: {
  viewport: HTMLElement;
  turnId: string;
  locate: (row: HTMLElement) => HTMLElement | undefined;
  prepare?: (target: HTMLElement) => void;
}): () => void {
  let raf = 0;
  let timer = 0;
  let flashed: HTMLElement | null = null;
  const deadline = performance.now() + 5000;
  const find = () => {
    const row = viewport.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
    const target = row ? locate(row) : undefined;
    if ((!target || !row?.getBoundingClientRect().height) && performance.now() < deadline) {
      raf = requestAnimationFrame(find);
      return;
    }
    if (!target) return;
    prepare?.(target);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    const flash = () => {
      flashed = target;
      target.classList.add("block-reveal-flash");
      timer = window.setTimeout(() => {
        target.classList.remove("block-reveal-flash");
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
    flashed?.classList.remove("block-reveal-flash");
  };
}
