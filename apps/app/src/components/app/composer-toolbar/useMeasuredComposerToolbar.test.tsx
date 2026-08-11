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
let resizeObservers: TestResizeObserver[] = [];
class TestResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();
  disconnected = false;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
  observe(target: Element) {
    this.observed.add(target);
  }
  unobserve(target: Element) {
    this.observed.delete(target);
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  deliver(target: Element) {
    if (!this.disconnected && this.observed.has(target)) this.callback([], this);
  }
}
let mutationObservers: TestMutationObserver[] = [];
class TestMutationObserver implements MutationObserver {
  readonly callback: MutationCallback;
  readonly observed = new Map<Node, MutationObserverInit>();
  disconnected = false;
  constructor(callback: MutationCallback) {
    this.callback = callback;
    mutationObservers.push(this);
  }
  observe(target: Node, options?: MutationObserverInit) {
    this.observed.set(target, options ?? {});
  }
  disconnect() {
    this.disconnected = true;
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  deliver(target: Node) {
    const registered = [...this.observed].some(
      ([root, options]) => root === target || (options.subtree && root.contains(target)),
    );
    if (!this.disconnected && registered) this.callback([], this);
  }
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
  vi.stubGlobal("MutationObserver", TestMutationObserver);
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  vi.unstubAllGlobals();
});
let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
beforeEach(() => {
  resizeObservers = [];
  mutationObservers = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
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
  const initialResizeObserver = resizeObservers.at(-1);
  const initialMutationObserver = mutationObservers.at(-1);
  expect(initialResizeObserver?.observed).toEqual(new Set([fieldset, probe, mode, work]));
  expect(initialMutationObserver?.observed).toEqual(
    new Map([
      [mode, { childList: true, characterData: true, subtree: true }],
      [work, { childList: true, characterData: true, subtree: true }],
    ]),
  );

  await act(async () => initialResizeObserver?.deliver(fieldset));
  expect(layouts.at(-1)?.inlineIds).toEqual(["mode", "work"]);

  await act(async () => root.render(<Harness locked onLayout={onLayout} />));
  expect(initialResizeObserver?.disconnected).toBe(true);
  expect(initialMutationObserver?.disconnected).toBe(true);
  expect(mode.style.width).toBe("80px");
  expect(work.style.width).toBe("80px");

  setNumber(label, "scrollWidth", 150);
  await act(async () => work.querySelector("button")?.click());
  const lockedMutationObserver = mutationObservers.at(-1);
  await act(async () => lockedMutationObserver?.deliver(label));
  expect(work.style.width).toBe("80px");
  expect(layouts.at(-1)?.inlineIds).toEqual(["mode"]);
  expect(layouts.at(-1)?.overflowIds).toEqual(["work"]);

  setNumber(label, "scrollWidth", 90);
  setNumber(fieldset, "clientWidth", 270);
  const lockedResizeObserver = resizeObservers.at(-1);
  await act(async () => lockedResizeObserver?.deliver(fieldset));
  expect(layouts.at(-1)?.inlineIds).toEqual(["mode", "work"]);
  expect(work.style.width).toBe("80px");

  await act(async () => root.render(<Harness locked={false} onLayout={onLayout} />));
  expect(lockedResizeObserver?.disconnected).toBe(true);
  expect(lockedMutationObserver?.disconnected).toBe(true);
  expect(mode.style.width).toBe("");
  expect(work.style.width).toBe("");
  expect(layouts.at(-1)?.inlineIds).toEqual(["mode", "work"]);

  await act(async () => root.render(<Harness locked onLayout={onLayout} />));
  const unmountedResizeObserver = resizeObservers.at(-1);
  const unmountedMutationObserver = mutationObservers.at(-1);
  expect(mode.style.width).toBe("80px");
  expect(work.style.width).toBe("80px");
  await act(async () => root.unmount());
  mounted = false;
  expect(unmountedResizeObserver?.disconnected).toBe(true);
  expect(unmountedMutationObserver?.disconnected).toBe(true);
  expect(mode.style.width).toBe("");
  expect(work.style.width).toBe("");
});
