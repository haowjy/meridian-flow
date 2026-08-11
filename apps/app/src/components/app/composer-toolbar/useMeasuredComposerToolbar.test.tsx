// @vitest-environment jsdom
/** DOM-boundary coverage for intrinsic toolbar measurement and locked allocation. */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ComposerToolbarLayout } from "./composer-toolbar-layout";
import { useMeasuredComposerToolbar } from "./useMeasuredComposerToolbar";

const controls = [
  { id: "mode", priority: 200 },
  { id: "work", priority: 100 },
];
let resizeCallbacks: ResizeObserverCallback[] = [];
class TestResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
const rect = (width: number) => new DOMRect(0, 0, width, 32);
const setNumber = (node: Element, property: string, value: number) =>
  Object.defineProperty(node, property, { configurable: true, get: () => value });

function Harness({
  locked,
  onLayout,
}: {
  locked: boolean;
  onLayout(layout: ComposerToolbarLayout): void;
}) {
  const measured = useMeasuredComposerToolbar(controls, onLayout, locked);
  const [workName, setWorkName] = useState("Book");
  return (
    <fieldset ref={measured.root} style={{ columnGap: "8px" }}>
      <span ref={measured.controlRef("mode")} data-control="mode">
        <button type="button">Draft</button>
      </span>
      <span ref={measured.controlRef("work")} data-control="work">
        <button type="button" onClick={() => setWorkName("A much longer Work label")}>
          <span data-slot="composer-current-value-label">{workName}</span>
        </button>
      </span>
      <button ref={measured.probe} type="button">
        More
      </button>
    </fieldset>
  );
}

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  vi.unstubAllGlobals();
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resizeCallbacks = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("freezes committed wrappers while locked, keeps intrinsic measurements live, and reconciles latest geometry on unlock", async () => {
  const layouts: ComposerToolbarLayout[] = [];
  const onLayout = (layout: ComposerToolbarLayout) => layouts.push(layout);
  await act(async () => root.render(<Harness locked={false} onLayout={onLayout} />));
  const fieldset = host.querySelector("fieldset") as HTMLFieldSetElement;
  const mode = host.querySelector('[data-control="mode"]') as HTMLElement;
  const work = host.querySelector('[data-control="work"]') as HTMLElement;
  const label = work.querySelector('[data-slot="composer-current-value-label"]') as HTMLElement;
  const probe = host.querySelector("fieldset > button") as HTMLButtonElement;
  setNumber(fieldset, "clientWidth", 240);
  mode.getBoundingClientRect = () => rect(80);
  work.getBoundingClientRect = () => rect(80);
  probe.getBoundingClientRect = () => rect(32);
  setNumber(mode, "scrollWidth", 80);
  setNumber(work, "scrollWidth", 80);
  setNumber(label, "clientWidth", 60);
  setNumber(label, "scrollWidth", 60);
  await act(async () => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));
  expect(layouts.at(-1)?.inlineIds).toEqual(["mode", "work"]);

  await act(async () => root.render(<Harness locked onLayout={onLayout} />));
  expect(mode.style.width).toBe("80px");
  expect(work.style.width).toBe("80px");

  setNumber(label, "scrollWidth", 150);
  await act(async () => work.querySelector("button")?.click());
  await act(async () => Promise.resolve());
  expect(work.style.width).toBe("80px");
  expect(layouts.at(-1)?.inlineIds).toEqual(["mode"]);
  expect(layouts.at(-1)?.overflowIds).toEqual(["work"]);

  setNumber(label, "scrollWidth", 90);
  setNumber(fieldset, "clientWidth", 270);
  await act(async () => resizeCallbacks.at(-1)?.([], {} as ResizeObserver));
  expect(layouts.at(-1)?.inlineIds).toEqual(["mode", "work"]);
  expect(work.style.width).toBe("80px");

  await act(async () => root.render(<Harness locked={false} onLayout={onLayout} />));
  expect(mode.style.width).toBe("");
  expect(work.style.width).toBe("");
  expect(layouts.at(-1)?.inlineIds).toEqual(["mode", "work"]);
});
