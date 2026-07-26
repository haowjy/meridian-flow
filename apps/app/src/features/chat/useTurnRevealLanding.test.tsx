/** The transcript's half of the reveal handshake: land the turn, or say it isn't here. */
import { act, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abandonConversationReveal,
  peekConversationReveal,
} from "@/test-support/conversation-reveal";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { requestConversationReveal, useConversationRevealRouting } from "./conversation-reveal";
import { useTurnRevealLanding } from "./useTurnRevealLanding";

const TURN_TARGET = { kind: "turn", threadId: "thread-1", turnId: "turn-2" } as const;

/**
 * jsdom reports every element as 0×0, which is also the real "docked chat is
 * still parked" case — so the harness sets a height explicitly and the tests
 * that want the parked viewport simply leave it at zero.
 */
type Observer = { trigger: () => void };
function stubResizeObserver(): Observer {
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {
        observers.push(() => this.callback());
      }
      observe() {}
      disconnect() {}
    },
  );
  return {
    trigger: () => {
      for (const notify of observers) notify();
    },
  };
}

/**
 * The transcript is only ever handed the turn stage after the shell lands the
 * thread, so every harness mounts the shell alongside it.
 */
function RevealShell() {
  useConversationRevealRouting(() => {});
  return null;
}

function transcript({
  turns,
  historySettled,
  viewportHeight,
  scrollToIndex,
}: {
  turns: { id: string }[];
  historySettled: boolean;
  viewportHeight: number;
  scrollToIndex: (index: number) => void;
}) {
  return function Transcript() {
    const viewportRef = useRef<HTMLElement | null>(null);
    const attach = (node: HTMLDivElement | null) => {
      if (node)
        Object.defineProperty(node, "clientHeight", { value: viewportHeight, configurable: true });
      viewportRef.current = node;
    };
    useTurnRevealLanding({
      threadId: "thread-1",
      turns,
      historySettled,
      viewportRef,
      scrollToIndex,
    });
    return (
      <>
        <RevealShell />
        <div ref={attach} />
      </>
    );
  };
}

afterEach(() => {
  abandonConversationReveal();
  vi.unstubAllGlobals();
});

describe("useTurnRevealLanding", () => {
  it("centers the named turn and reports it landed", async () => {
    const scrollToIndex = vi.fn();
    const Transcript = transcript({
      turns: [{ id: "turn-1" }, { id: "turn-2" }],
      historySettled: true,
      viewportHeight: 600,
      scrollToIndex,
    });

    await withReactRoot(<Transcript />, async () => {
      await act(async () => requestConversationReveal(TURN_TARGET));
      expect(scrollToIndex).toHaveBeenCalledWith(1);
      expect(peekConversationReveal()).toBeNull();
    });
  });

  it("degrades to the thread when a settled transcript has no such turn", async () => {
    const scrollToIndex = vi.fn();
    const Transcript = transcript({
      turns: [{ id: "turn-1" }],
      historySettled: true,
      viewportHeight: 600,
      scrollToIndex,
    });

    await withReactRoot(<Transcript />, async () => {
      await act(async () => requestConversationReveal(TURN_TARGET));
      expect(scrollToIndex).not.toHaveBeenCalled();
      // Cleared, not pending: the writer is left in the conversation itself.
      expect(peekConversationReveal()).toBeNull();
    });
  });

  it("keeps the request while history is still loading", async () => {
    const Transcript = transcript({
      turns: [],
      historySettled: false,
      viewportHeight: 600,
      scrollToIndex: vi.fn(),
    });

    await withReactRoot(<Transcript />, async () => {
      await act(async () => requestConversationReveal(TURN_TARGET));
      // A turn that hasn't arrived is not a turn that isn't there.
      expect(peekConversationReveal()).toEqual(TURN_TARGET);
    });
  });

  it("waits for a parked viewport to get its size before centering", async () => {
    stubResizeObserver();
    const scrollToIndex = vi.fn();
    const Transcript = transcript({
      turns: [{ id: "turn-1" }, { id: "turn-2" }],
      historySettled: true,
      // The docked chat un-collapses in the same commit that delivers the
      // request; centering inside a 0-height scroller computes garbage.
      viewportHeight: 0,
      scrollToIndex,
    });

    await withReactRoot(<Transcript />, async () => {
      await act(async () => requestConversationReveal(TURN_TARGET));
      expect(scrollToIndex).not.toHaveBeenCalled();
      expect(peekConversationReveal()).toEqual(TURN_TARGET);
    });
  });

  it("lands once the parked viewport is measured", async () => {
    const resize = stubResizeObserver();
    const scrollToIndex = vi.fn();
    let height = 0;
    function Transcript() {
      const viewportRef = useRef<HTMLElement | null>(null);
      const attach = (node: HTMLDivElement | null) => {
        if (node)
          Object.defineProperty(node, "clientHeight", { get: () => height, configurable: true });
        viewportRef.current = node;
      };
      useTurnRevealLanding({
        threadId: "thread-1",
        turns: [{ id: "turn-1" }, { id: "turn-2" }],
        historySettled: true,
        viewportRef,
        scrollToIndex,
      });
      return (
        <>
          <RevealShell />
          <div ref={attach} />
        </>
      );
    }

    await withReactRoot(<Transcript />, async () => {
      await act(async () => requestConversationReveal(TURN_TARGET));
      height = 600;
      await act(async () => resize.trigger());
      expect(scrollToIndex).toHaveBeenCalledWith(1);
      expect(peekConversationReveal()).toBeNull();
    });
  });
});
