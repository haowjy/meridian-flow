/** Public interaction contract for the measured composer toolbar. */
// @vitest-environment jsdom
import { act, type RefObject, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerToolbar } from "./ComposerToolbar";
import type { ComposerToolbarControl } from "./types";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let availableWidth = 500;
let resizeCallbacks: ResizeObserverCallback[] = [];
let root: Root | undefined;
let host: HTMLDivElement | undefined;

class ControlledResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const click = (element: Element) =>
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const userClick = (element: Element) =>
  act(() => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
const button = (name: string) => {
  const match = [...document.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent?.trim() === name,
  );
  if (!match) throw new Error(`Missing button: ${name}`);
  return match as HTMLButtonElement;
};
const flush = () => act(async () => {});

function PanelBody({
  name,
  focusRef,
  close,
  lock,
}: {
  name: string;
  focusRef: RefObject<HTMLInputElement | null>;
  close(): void;
  lock(): void;
}) {
  return (
    <div>
      <input ref={focusRef} aria-label={`${name} search`} />
      <button type="button" onClick={lock}>
        Lock {name}
      </button>
      <button type="button" onClick={close}>
        Dismiss {name}
      </button>
      <button type="button" onClick={close}>
        Complete {name}
      </button>
    </div>
  );
}

function Harness() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [lockedId, setLockedId] = useState<string | null>(null);
  const workFocus = useRef<HTMLInputElement>(null);
  const modeFocus = useRef<HTMLInputElement>(null);
  const panel = (
    id: string,
    name: string,
    initialFocusRef: RefObject<HTMLInputElement | null>,
  ): ComposerToolbarControl => ({
    id,
    priority: id === "work" ? 100 : 200,
    inline: ({ requestOpen }) => (
      <button type="button" aria-label={`${name} trigger`} onClick={requestOpen}>
        {name}
      </button>
    ),
    overflow: {
      kind: "panel",
      item: { ariaLabel: `Open ${name}`, label: name },
      panel: {
        open: openId === id,
        busy: lockedId === id,
        canDismiss: lockedId !== id,
        ariaLabel: `${name} panel`,
        size: "compact",
        initialFocusRef,
        onRequestOpen: () => setOpenId(id),
        onRequestDismiss: () => setOpenId(null),
        render: () => (
          <PanelBody
            name={name}
            focusRef={initialFocusRef}
            close={() => setOpenId(null)}
            lock={() => setLockedId(id)}
          />
        ),
      },
    },
  });
  const controls: ComposerToolbarControl[] = [
    panel("work", "Work", workFocus),
    panel("mode", "Mode", modeFocus),
    {
      id: "agent",
      priority: 300,
      inline: () => <span>Agent offline</span>,
      overflow: {
        kind: "status",
        item: { ariaLabel: "Agent status", label: "Agent", value: "Offline" },
      },
    },
  ];
  return <ComposerToolbar controls={controls} ariaLabel="Composer controls" />;
}

function mount(width: number) {
  availableWidth = width;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<Harness />));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.spyOn(HTMLFieldSetElement.prototype, "clientWidth", "get").mockImplementation(
    () => availableWidth,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const width =
      this instanceof HTMLSpanElement && this.parentElement instanceof HTMLFieldSetElement
        ? 100
        : 40;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 40,
      width,
      height: 40,
      toJSON() {},
    };
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  resizeCallbacks = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ComposerToolbar", () => {
  it("focuses the panel target on drill-in and the exact root row on Back", async () => {
    mount(120);
    click(button("More composer controls"));
    click(button("Open Work"));
    await flush();
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Work search"]'));

    click(button("Back"));
    await flush();
    expect(document.activeElement).toBe(button("Open Work"));
  });

  it.each([
    "Dismiss Work",
    "Complete Work",
  ])("returns focus to the visible semantic trigger after %s", async (action) => {
    mount(500);
    click(button("Work trigger"));
    await flush();
    click(button(action));
    await flush();
    expect(document.activeElement).toBe(button("Work trigger"));
  });

  it("returns focus to the visible trigger after Escape", async () => {
    mount(500);
    click(button("Work trigger"));
    await flush();
    act(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await flush();
    expect(document.querySelector('[aria-label="Work panel"]')).toBeNull();
    expect(document.activeElement).toBe(button("Work trigger"));
  });

  it("keeps one panel open and rejects another open while it is nondismissible", async () => {
    mount(500);
    click(button("Work trigger"));
    await flush();
    click(button("Dismiss Work"));
    await flush();
    click(button("Mode trigger"));
    await flush();
    expect(document.querySelector('[aria-label="Work panel"]')).toBeNull();
    expect(document.querySelector('[aria-label="Mode panel"]')).not.toBeNull();

    click(button("Dismiss Mode"));
    await flush();
    click(button("Work trigger"));
    click(button("Lock Work"));
    userClick(button("Mode trigger"));
    await flush();
    expect(document.querySelector('[aria-label="Work panel"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Mode panel"]')).toBeNull();
  });

  it("migrates an open panel without a stale host and restores panel focus", async () => {
    mount(500);
    click(button("Work trigger"));
    await flush();
    availableWidth = 120;
    act(() => {
      for (const callback of [...resizeCallbacks]) callback([], {} as ResizeObserver);
    });
    await flush();
    expect(
      document.querySelector('[aria-label="More composer controls"]'),
      document.body.innerHTML,
    ).not.toBeNull();
    expect(
      document.querySelectorAll('[aria-label="Work panel"]'),
      document.body.innerHTML,
    ).toHaveLength(1);
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Work search"]'));
    expect(button("Work trigger").closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("renders readonly overflow status as a noninteractive row", () => {
    mount(120);
    click(button("More composer controls"));
    const status = [...document.querySelectorAll("li")].find((node) =>
      node.textContent?.includes("AgentOffline"),
    );
    expect(status).toBeDefined();
    expect(status?.querySelector("button, [role=button]")).toBeNull();
  });

  it("closes the overflow surface on terminal Work completion", async () => {
    mount(120);
    click(button("More composer controls"));
    click(button("Open Work"));
    await flush();
    click(button("Complete Work"));
    await flush();
    expect(document.querySelector('[data-page="root"]')).toBeNull();
    expect(document.activeElement).toBe(button("More composer controls"));
  });
});
