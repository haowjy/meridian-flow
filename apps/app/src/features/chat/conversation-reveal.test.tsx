/**
 * Stage ownership of the editor-to-conversation reveal.
 *
 * Drives the three stage hooks the way the four real surfaces do — shell,
 * transcript, receipt — and proves a request always ends: landed at its target
 * or degraded to the deepest stage that did land.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  abandonConversationReveal,
  type ChangeRevealRequest,
  peekConversationReveal,
  requestConversationReveal,
  type TurnRevealRequest,
  useChangeReveal,
  useConversationRevealRouting,
  useTurnReveal,
} from "./conversation-reveal";

const CHANGE_TARGET = {
  kind: "change",
  threadId: "thread-1",
  turnId: "turn-1",
  changeId: "change-1",
} as const;

type Surfaces = {
  routed: string[];
  turn: TurnRevealRequest | null;
  change: ChangeRevealRequest | null;
};

/** One harness standing in for the shell, the transcript, and the receipt. */
function surfaces(threadId = "thread-1", turnId = "turn-1") {
  const seen: Surfaces = { routed: [], turn: null, change: null };
  function Surfaces() {
    useConversationRevealRouting((id) => seen.routed.push(id));
    seen.turn = useTurnReveal(threadId);
    seen.change = useChangeReveal(threadId, turnId);
    return null;
  }
  return { seen, Surfaces };
}

afterEach(() => abandonConversationReveal());

describe("conversation reveal stages", () => {
  it("hands a change request down shell → transcript → receipt", async () => {
    const { seen, Surfaces } = surfaces();
    await withReactRoot(<Surfaces />, async () => {
      await act(async () => requestConversationReveal(CHANGE_TARGET));
      // The shell lands the thread on arrival; nothing deeper is offered yet.
      expect(seen.routed).toEqual(["thread-1"]);
      expect(seen.turn).toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
      expect(seen.change).toBeNull();

      await act(async () => seen.turn?.landed());
      expect(seen.turn).toBeNull();
      expect(seen.change).toMatchObject({ changeId: "change-1" });

      await act(async () => seen.change?.landed());
      expect(peekConversationReveal()).toBeNull();
    });
  });

  it("ends a thread request at the shell", async () => {
    const { seen, Surfaces } = surfaces();
    await withReactRoot(<Surfaces />, async () => {
      await act(async () => requestConversationReveal({ kind: "thread", threadId: "thread-1" }));
      expect(seen.routed).toEqual(["thread-1"]);
      expect(peekConversationReveal()).toBeNull();
      expect(seen.turn).toBeNull();
    });
  });

  it("ends a turn request at the transcript", async () => {
    const { seen, Surfaces } = surfaces();
    await withReactRoot(<Surfaces />, async () => {
      await act(async () =>
        requestConversationReveal({ kind: "turn", threadId: "thread-1", turnId: "turn-1" }),
      );
      await act(async () => seen.turn?.landed());
      expect(peekConversationReveal()).toBeNull();
      expect(seen.change).toBeNull();
    });
  });

  it("degrades to the thread when the turn is unavailable", async () => {
    const { seen, Surfaces } = surfaces();
    await withReactRoot(<Surfaces />, async () => {
      await act(async () => requestConversationReveal(CHANGE_TARGET));

      await act(async () => seen.turn?.unavailable());

      // The receipt is never asked: the writer stays in the thread the shell
      // already opened, and no request is left in flight.
      expect(seen.change).toBeNull();
      expect(peekConversationReveal()).toBeNull();
    });
  });

  it("degrades to the turn when the change is unavailable", async () => {
    const { seen, Surfaces } = surfaces();
    await withReactRoot(<Surfaces />, async () => {
      await act(async () => requestConversationReveal(CHANGE_TARGET));
      await act(async () => seen.turn?.landed());

      await act(async () => seen.change?.unavailable());

      expect(peekConversationReveal()).toBeNull();
    });
  });

  it("offers a turn only to the transcript that owns the thread", async () => {
    const { seen, Surfaces } = surfaces("other-thread");
    await withReactRoot(<Surfaces />, async () => {
      await act(async () => requestConversationReveal(CHANGE_TARGET));
      expect(seen.turn).toBeNull();
    });
  });

  it("offers a change only to the receipt that owns the turn", async () => {
    const { seen, Surfaces } = surfaces("thread-1", "other-turn");
    await withReactRoot(<Surfaces />, async () => {
      await act(async () => requestConversationReveal(CHANGE_TARGET));
      await act(async () => seen.turn?.landed());
      expect(seen.change).toBeNull();
    });
  });

  it("ignores a report from a stage that already settled", async () => {
    const { seen, Surfaces } = surfaces();
    await withReactRoot(<Surfaces />, async () => {
      await act(async () => requestConversationReveal(CHANGE_TARGET));
      const turn = seen.turn;
      await act(async () => turn?.landed());

      // A late duplicate (an effect re-running against a captured request) must
      // not rewind the handshake to a stage the writer is already past.
      await act(async () => turn?.unavailable());

      expect(seen.change).toMatchObject({ changeId: "change-1" });
      expect(peekConversationReveal()).toEqual(CHANGE_TARGET);
    });
  });

  it("ignores a report from a superseded request", async () => {
    const { seen, Surfaces } = surfaces();
    await withReactRoot(<Surfaces />, async () => {
      await act(async () => requestConversationReveal(CHANGE_TARGET));
      const stale = seen.turn;

      await act(async () =>
        requestConversationReveal({ kind: "turn", threadId: "thread-1", turnId: "turn-2" }),
      );
      await act(async () => stale?.landed());

      expect(seen.turn).toMatchObject({ turnId: "turn-2" });
      expect(peekConversationReveal()).toEqual({
        kind: "turn",
        threadId: "thread-1",
        turnId: "turn-2",
      });
    });
  });
});
