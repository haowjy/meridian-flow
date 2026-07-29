// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPanZoomViewer, type PanZoomViewer } from "./pan-zoom-viewer";

/**
 * jsdom has no layout, so the sizes every viewer decision rests on are stubbed
 * here. The arithmetic those numbers feed is covered exhaustively in
 * `viewer-math.test.ts`; what this file protects is the DOM contract — what the
 * viewer writes, what it listens to, and whether it gives all of it back.
 */
function sized(element: HTMLElement, width: number, height: number) {
  Object.defineProperty(element, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: height, configurable: true });
  Object.defineProperty(element, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(element, "offsetHeight", { value: height, configurable: true });
}

let host: HTMLElement;
let content: HTMLElement;
let viewer: PanZoomViewer | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});

  host = document.createElement("div");
  content = document.createElement("div");
  host.append(content);
  document.body.append(host);
  sized(host, 800, 600);
  sized(content, 400, 300);

  host.setPointerCapture = vi.fn();
  host.releasePointerCapture = vi.fn();
  host.hasPointerCapture = vi.fn().mockReturnValue(true);
});

afterEach(() => {
  viewer?.destroy();
  viewer = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function pointer(type: string, init: PointerEventInit = {}): Event {
  // jsdom ships no PointerEvent constructor; the viewer only reads these five.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  Object.defineProperty(event, "pointerType", { value: init.pointerType ?? "mouse" });
  return event;
}

describe("what the viewer gives back", () => {
  it("restores the styles it borrowed from the caller's element", () => {
    content.style.transform = "rotate(3deg)";
    content.style.transformOrigin = "30% 40%";
    content.style.willChange = "opacity";

    viewer = createPanZoomViewer({ host, content });
    expect(content.style.transform).not.toBe("rotate(3deg)");

    viewer.destroy();
    viewer = null;

    // The caller owns this element. A viewer that leaves its own transform
    // behind has silently taken it over for good.
    expect(content.style.transform).toBe("rotate(3deg)");
    expect(content.style.transformOrigin).toBe("30% 40%");
    expect(content.style.willChange).toBe("opacity");
  });

  it("leaves no gesture state on the host", () => {
    viewer = createPanZoomViewer({ host, content });
    host.dispatchEvent(pointer("pointerdown"));
    expect(host.dataset.panning).toBe("");

    viewer.destroy();
    viewer = null;

    expect(host.dataset.panning).toBeUndefined();
    // A pointer still captured after teardown sends every later move to an
    // element nobody is listening on.
    expect(host.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it("stops listening", () => {
    viewer = createPanZoomViewer({ host, content });
    const before = viewer.scale;

    viewer.destroy();
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, cancelable: true }));

    expect(viewer.scale).toBe(before);
    viewer = null;
  });

  it("is inert afterwards", () => {
    viewer = createPanZoomViewer({ host, content });
    viewer.destroy();

    const scale = viewer.scale;
    viewer.zoomBy(4);
    viewer.panBy({ x: 100, y: 100 });
    viewer.fit();

    // A late React effect calling into a destroyed viewer must not write to an
    // element the caller has moved on from.
    expect(viewer.scale).toBe(scale);
    expect(content.style.transform).toBe("");
    viewer = null;
  });
});

describe("mounting", () => {
  it("opens fitted and centered", () => {
    viewer = createPanZoomViewer({ host, content, padding: 0 });

    expect(viewer.scale).toBeCloseTo(2, 10);
    expect(viewer.pan).toEqual({ x: 0, y: 0 });
    expect(viewer.fitted).toBe(true);
    expect(viewer.sizes()).toMatchObject({
      host: { width: 800, height: 600 },
      content: { width: 400, height: 300 },
      realZoom: 2,
    });
  });

  it("stops being fitted once a gesture moves it", () => {
    viewer = createPanZoomViewer({ host, content, padding: 0 });
    viewer.panBy({ x: 10, y: 0 });
    expect(viewer.fitted).toBe(false);

    viewer.fit();
    expect(viewer.fitted).toBe(true);
  });
});
