// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationRevealController } from "./conversation-reveal-controller";
import {
  subagentBlockRevealTarget,
  toolCallRevealTarget,
  useTurnRevealLanding,
} from "./useTurnRevealLanding";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("subagent block reveal targeting", () => {
  it("selects the latest matching launch, finished, or report block in one turn", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div data-subagent-thread-id="child"></div>
      <div data-subagent-thread-id="other"></div>
      <div data-subagent-thread-id="child"></div>
    `;
    expect(subagentBlockRevealTarget(row, "child")).toBe(row.lastElementChild);
    expect(subagentBlockRevealTarget(row, "missing")).toBeUndefined();
  });

  it("lands on the launch card when asked, even after a later finished line", () => {
    const row = document.createElement("div");
    row.innerHTML = `
      <div data-subagent-card data-subagent-thread-id="child" id="card"></div>
      <div data-subagent-finished data-subagent-thread-id="child"></div>
    `;
    expect(subagentBlockRevealTarget(row, "child", "card")?.id).toBe("card");
  });
});

describe("tool call reveal targeting", () => {
  const turn = (open: boolean) => {
    const row = document.createElement("div");
    row.innerHTML = `
      <button data-tool-call-ids="call-1 call-2" id="fold"></button>
      <div data-process-fold aria-hidden="${open ? "false" : "true"}">
        <div data-tool-call-id="call-1" id="row-1"></div>
        <div data-tool-call-id="call-2" id="row-2"></div>
      </div>
    `;
    return row;
  };

  it("lands on the exact row when its fold is open", () => {
    expect(toolCallRevealTarget(turn(true), "call-2")?.id).toBe("row-2");
  });

  it("lands on the closed fold, not the hidden row", () => {
    expect(toolCallRevealTarget(turn(false), "call-2")?.id).toBe("fold");
  });

  it("finds nothing for a call the turn does not hold, leaving the landing on the turn", () => {
    expect(toolCallRevealTarget(turn(false), "call-9")).toBeUndefined();
  });
});

describe("turn landing in a transcript that is still loading", () => {
  afterEach(() => conversationRevealController.cancel());

  function mountLanding() {
    const viewport = document.createElement("div");
    Object.defineProperty(viewport, "clientHeight", { value: 800 });
    const scrollToIndex = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    function Landing({ ids, settled }: { ids: string[]; settled: boolean }) {
      useTurnRevealLanding({
        threadId: "thread-1",
        turns: ids.map((id) => ({ id })),
        historySettled: settled,
        viewportRef: { current: viewport },
        scrollToIndex,
      });
      return null;
    }
    const render = (ids: string[], settled: boolean) =>
      act(async () => root.render(createElement(Landing, { ids, settled })));
    return { render, scrollToIndex, unmount: () => act(async () => root.unmount()) };
  }

  const requestTurn = () => {
    conversationRevealController.request({ kind: "turn", threadId: "thread-1", turnId: "t2" });
    conversationRevealController.snapshot().thread?.landed();
  };

  it("waits for the thread's turns and lands once they arrive", async () => {
    const landing = mountLanding();
    await landing.render([], false);
    requestTurn();
    await landing.render([], false);
    expect(conversationRevealController.snapshot().turn).not.toBeNull();
    expect(landing.scrollToIndex).not.toHaveBeenCalled();

    await landing.render(["t1", "t2", "t3"], true);
    expect(landing.scrollToIndex).toHaveBeenCalledWith(1);
    expect(conversationRevealController.snapshot().turn).toBeNull();
    await landing.unmount();
  });

  it("gives the request up when settled history does not hold the turn", async () => {
    const landing = mountLanding();
    await landing.render([], false);
    requestTurn();
    await landing.render(["t1"], true);
    expect(landing.scrollToIndex).not.toHaveBeenCalled();
    expect(conversationRevealController.snapshot().turn).toBeNull();
    await landing.unmount();
  });
});
