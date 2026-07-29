import { describe, expect, it, vi } from "vitest";

import { createEditorChrome } from "./editor-chrome";
import { CHROME_TIMING, type HoverIntentTimers } from "./hover-intent";

/** A hand-cranked clock, so the timing policy is asserted rather than waited on. */
function fakeTimers() {
  const queued = new Map<number, { run: () => void; at: number }>();
  let handle = 0;
  let now = 0;

  const timers: HoverIntentTimers = {
    setTimeout(run, ms) {
      handle += 1;
      queued.set(handle, { run, at: now + ms });
      return handle;
    },
    clearTimeout(id) {
      queued.delete(id);
    },
  };

  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...queued]) {
        if (entry.at > now) continue;
        queued.delete(id);
        entry.run();
      }
    },
  };
}

describe("chrome layers", () => {
  it("closes the topmost layer through the surface's own dismissal", () => {
    const { chrome } = createEditorChrome();
    const closeDialog = vi.fn();
    const closeSource = vi.fn();

    chrome.openLayer({ id: "dialog", close: closeDialog });
    const source = chrome.openLayer({ id: "source", close: closeSource });

    expect(chrome.closeTopLayer()).toBe(true);
    expect(closeSource).toHaveBeenCalledOnce();
    expect(closeDialog).not.toHaveBeenCalled();

    // The surface's own close path releases the handle; only then does the
    // chain move on. Closing here and popping here would race the animation.
    expect(chrome.layers.map((layer) => layer.id)).toEqual(["dialog", "source"]);
    source.release();
    expect(chrome.layers.map((layer) => layer.id)).toEqual(["dialog"]);
  });

  it("reports no layer to close when nothing is open", () => {
    const { chrome } = createEditorChrome();
    expect(chrome.closeTopLayer()).toBe(false);
  });

  it("keeps two opens of one surface distinct rather than leaving a ghost step", () => {
    const { chrome } = createEditorChrome();
    const first = chrome.openLayer({ id: "menu", close: () => {} });
    const second = chrome.openLayer({ id: "menu", close: () => {} });

    expect(first.id).not.toBe(second.id);
    second.release();
    expect(chrome.layers).toHaveLength(1);
  });
});

describe("gesture suppression", () => {
  it("suppresses for a surface-owned drag and re-evaluates on release", () => {
    const { chrome } = createEditorChrome();
    const listener = vi.fn();
    chrome.subscribe(listener);

    const endDrag = chrome.beginDrag();
    expect(chrome.suppressed).toBe(true);
    endDrag();
    expect(chrome.suppressed).toBe(false);
    // Two notifications: one to stand down, one to look again.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("lets Esc reach a drag its owner is running", () => {
    const { chrome, controller } = createEditorChrome();
    const abandonDrag = vi.fn();
    chrome.beginDrag(abandonDrag);

    controller.cancelGesture();

    expect(abandonDrag).toHaveBeenCalledOnce();
    expect(chrome.gesture).toBe("idle");
  });

  it("gives each drag its own end, so a stale one cannot release a newer drag", () => {
    const { chrome } = createEditorChrome();

    const endFirst = chrome.beginDrag();
    const endSecond = chrome.beginDrag();

    // The block handle's drag ended a frame late while the column resize is
    // still running. The late call belongs to a gesture nobody is holding.
    endFirst();
    expect(chrome.gesture).toBe("drag");
    expect(chrome.suppressed).toBe(true);

    endSecond();
    expect(chrome.gesture).toBe("idle");
  });

  it("cancels the drag it replaced, so no owner is left holding a dead pointer", () => {
    const { chrome } = createEditorChrome();
    const abandonFirst = vi.fn();

    chrome.beginDrag(abandonFirst);
    chrome.beginDrag();

    expect(abandonFirst).toHaveBeenCalledOnce();
  });

  it("cancels only the drag that is running", () => {
    const { chrome, controller } = createEditorChrome();
    const abandonFirst = vi.fn();
    const abandonSecond = vi.fn();

    chrome.beginDrag(abandonFirst);
    chrome.beginDrag(abandonSecond);
    // Replacing the first drag already cancelled it; what Esc must not do is
    // reach back and cancel it a second time.
    abandonFirst.mockClear();

    controller.cancelGesture();

    expect(abandonSecond).toHaveBeenCalledOnce();
    expect(abandonFirst).not.toHaveBeenCalled();
    expect(chrome.gesture).toBe("idle");
  });

  it("drops revealed approach chrome the moment a gesture starts", () => {
    const { chrome } = createEditorChrome();
    const { timers, advance } = fakeTimers();
    const settled = vi.fn();
    const intent = chrome.createHoverIntent({ onSettle: settled, timers });

    intent.enter("figure");
    advance(CHROME_TIMING.handleIntentMs);
    expect(settled).toHaveBeenLastCalledWith("figure");

    chrome.beginDrag();
    expect(settled).toHaveBeenLastCalledWith(null);
  });
});

describe("hover intent", () => {
  it("ignores a pointer crossing the page and answers one that rests", () => {
    const { chrome } = createEditorChrome();
    const { timers, advance } = fakeTimers();
    const settled = vi.fn();
    const intent = chrome.createHoverIntent({ onSettle: settled, timers });

    intent.enter("figure");
    advance(CHROME_TIMING.handleIntentMs - 1);
    intent.leave();
    advance(1_000);
    expect(settled).not.toHaveBeenCalled();

    intent.enter("figure");
    advance(CHROME_TIMING.handleIntentMs);
    expect(settled).toHaveBeenCalledExactlyOnceWith("figure");
  });

  it("answers the next object immediately once something is already revealed", () => {
    const { chrome } = createEditorChrome();
    const { timers, advance } = fakeTimers();
    const settled = vi.fn();
    const intent = chrome.createHoverIntent({ onSettle: settled, timers });

    intent.enter("first");
    advance(CHROME_TIMING.handleIntentMs);
    intent.enter("second");

    expect(settled).toHaveBeenLastCalledWith("second");
  });

  it("holds the row through the grace so the pointer can cross onto it", () => {
    const { chrome } = createEditorChrome();
    const { timers, advance } = fakeTimers();
    const settled = vi.fn();
    const intent = chrome.createHoverIntent({ onSettle: settled, timers });

    intent.enter("figure");
    advance(CHROME_TIMING.handleIntentMs);
    settled.mockClear();

    intent.leave();
    advance(CHROME_TIMING.fadeMs - 1);
    intent.enter("figure");
    advance(1_000);

    expect(settled).not.toHaveBeenCalled();
    expect(intent.settled).toBe("figure");
  });
});

describe("keymap registration", () => {
  it("bumps a revision so a merged keymap can be cached across keystrokes", () => {
    const { chrome } = createEditorChrome();
    const before = chrome.keymapRevision;

    const release = chrome.registerKeymap({ id: "slash", scope: "layer", bindings: {} });
    expect(chrome.keymapRevision).toBeGreaterThan(before);

    const afterRegister = chrome.keymapRevision;
    release();
    expect(chrome.keymapRevision).toBeGreaterThan(afterRegister);
    release();
    expect(chrome.keymapRevision).toBe(afterRegister + 1);
  });
});
