// @vitest-environment jsdom
/** Before-mutation capture, visible pending, focus and the absolute patience bound. */
import { act, StrictMode, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { PaintCapture, PaintHold, PaintScope, usePaintPending } from "./PaintHold";

let move: (name: string, pending?: boolean, active?: boolean) => void;
let frame: () => void;
function Pending() {
  usePaintPending();
  return <p>Loading</p>;
}
function Pane({ precursor = false }: { precursor?: boolean }) {
  const [surface, setSurface] = useState({ name: "old", pending: false, active: true });
  move = (name, pending = false, active = true) => setSurface({ name, pending, active });
  useLayoutEffect(() => {
    if (precursor && surface.name === "intermediate") move("next", true);
  }, [precursor, surface.name]);
  return (
    <>
      <h1>{surface.name}</h1>
      <PaintScope active={surface.active}>
        <PaintCapture surface={surface.name} state={surface.pending ? "pending" : "painted"} />
        {surface.pending ? <Pending /> : <input id="unique" defaultValue={surface.name} />}
      </PaintScope>
    </>
  );
}
const cover = () => document.querySelector("[data-paint-hold]");
async function run(test: () => Promise<void>, precursor = false) {
  await withReactRoot(
    <StrictMode>
      <PaintHold status="Opening destination">
        <Pane precursor={precursor} />
      </PaintHold>
    </StrictMode>,
    test,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  frame = () => {};
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: () => void) => {
      frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("holds the whole frame through a pending handoff, then swaps in the ending commit", async () => {
  await run(async () => {
    await act(async () => move("next", true));
    expect(cover()?.textContent).toBe("old");
    expect(cover()?.querySelector("[id]")).toBeNull();
    expect(document.querySelector("[data-paint-page]")?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Opening destination");
    await act(async () => move("shell", true));
    expect(cover()?.textContent).toBe("old");
    await act(async () => move("ready"));
    expect(cover()).toBeNull();
  });
});
it("a deep capture copies an earlier sibling although its frame never renders", async () => {
  await run(async () => {
    await act(async () => move("next", true));
    expect(cover()?.querySelector("h1")?.textContent).toBe("old");
  });
});
it("drops warm changes unseen and reuses a painted copy across synchronous precursor commits", async () => {
  await run(async () => {
    await act(async () => move("warm"));
    expect(cover()).toBeNull();
    act(() => frame());
    await act(async () => move("intermediate"));
    expect(cover()?.querySelector("h1")?.textContent).toBe("warm");
  }, true);
});
it("keeps the first copy on a second move and releases for a terminal surface", async () => {
  await run(async () => {
    await act(async () => move("one", true));
    await act(async () => move("two", true));
    expect(cover()?.textContent).toBe("old");
    await act(async () => move("error"));
    expect(cover()).toBeNull();
  });
});
it("ignores inactive loading and releases when its scope deactivates", async () => {
  await run(async () => {
    await act(async () => move("hidden", true, false));
    expect(cover()).toBeNull();
    await act(async () => move("activating", true));
    expect(cover()).toBeNull();
    act(() => frame());
    await act(async () => move("finished"));
    act(() => frame());
    await act(async () => move("pending", true));
    expect(cover()).not.toBeNull();
    await act(async () => move("pending", true, false));
    expect(cover()).toBeNull();
  });
});
it("moves page focus to status and returns it to the frame", async () => {
  await run(async () => {
    document.querySelector("input")?.focus();
    await act(async () => move("next", true));
    expect(document.activeElement?.getAttribute("role")).toBe("status");
    await act(async () => move("ready"));
    expect(document.activeElement?.querySelector("[data-paint-page]")).not.toBeNull();
  });
});
it("ends at ten seconds without extending the bound for a second move", async () => {
  await run(async () => {
    await act(async () => move("one", true));
    act(() => vi.advanceTimersByTime(9000));
    await act(async () => move("two", true));
    act(() => vi.advanceTimersByTime(1000));
    expect(cover()).toBeNull();
  });
});

it("keeps D's painted prose and header when tokens retire before E registers", async () => {
  let transition: (phase: number) => void = () => {};
  function Handoff() {
    const [phase, setPhase] = useState(0);
    transition = setPhase;
    usePaintPending(phase === 1 || phase === 3);
    return (
      <>
        <PaintCapture surface={String(phase)} state={phase ? "pending" : "painted"} />
        {phase < 2 ? (
          <>
            <h1>D review header</h1>
            <p>D prose</p>
          </>
        ) : (
          <p>Opening document…</p>
        )}
      </>
    );
  }
  await withReactRoot(
    <PaintHold status="Opening E">
      <Handoff />
    </PaintHold>,
    async () => {
      await act(async () => transition(1));
      await act(async () => transition(2));
      act(() => frame());
      expect(cover()?.textContent).toBe("D review headerD prose");
      await act(async () => transition(3));
      expect(cover()?.textContent).toBe("D review headerD prose");
      expect(cover()?.textContent).not.toContain("Opening document…");
    },
  );
});
