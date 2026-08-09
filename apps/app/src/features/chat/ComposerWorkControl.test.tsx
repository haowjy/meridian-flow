// @vitest-environment jsdom
/** Real Work adapter integration over its controlled binding-hook seam. */
import type { Work } from "@meridian/contracts/works";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ComposerToolbar, createComposerToolbarModel } from "@/components/app/composer-toolbar";
import { useComposerWorkToolbarControl } from "./ComposerWorkControl";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
type ReadyController = ReturnType<typeof readyController>;
type ControlledController =
  | ReadyController
  | (Omit<ReadyController, "catalog"> & {
      catalog: { status: "error"; retry: () => void };
    });
let controller: ControlledController;
vi.mock("./useComposerWorkBinding", () => ({ useComposerWorkBinding: () => controller }));
vi.mock("@/components/app/composer-toolbar/useMeasuredComposerToolbar", async () => {
  const { useLayoutEffect, useRef } = await import("react");
  return {
    useMeasuredComposerToolbar: (
      controls: readonly { id: string }[],
      onLayout: (layout: {
        inlineIds: string[];
        overflowIds: string[];
        constrained: boolean;
      }) => void,
    ) => {
      const root = useRef<HTMLFieldSetElement | null>(null);
      const probe = useRef<HTMLButtonElement | null>(null);
      useLayoutEffect(
        () =>
          onLayout({
            inlineIds: controls.map(({ id }) => id),
            overflowIds: [],
            constrained: false,
          }),
        [controls, onLayout],
      );
      return { root, probe, controlRef: () => () => {} };
    },
  };
});

const current = { id: "current", name: "Current Work", goal: "Begin", status: "active" } as Work;
const next = { id: "next", name: "Next Work", goal: "Climb", status: "active" } as Work;
const retry = vi.fn();
function readyController(query = "", busy = false) {
  return {
    state: { view: { kind: "browsing" as const, query } },
    catalog: { status: "ready" as const, works: [current, next], refreshing: false },
    operation: {
      currentWorkId: current.id,
      targetId: busy ? next.id : null,
      pending: busy,
      failure: null,
    },
    undoWork: next,
    busy,
    changeQuery: vi.fn(),
    choose: vi.fn(async () => "close" as const),
    undo: vi.fn(),
    retryCatalog: retry,
  };
}
function Harness() {
  const control = useComposerWorkToolbarControl({
    projectId: "project",
    threadId: "thread",
    work: current,
  });
  return <ComposerToolbar model={createComposerToolbarModel([control])} ariaLabel="Options" />;
}
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("useComposerWorkToolbarControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    retry.mockClear();
  });

  it("owns Search/row repair, mutation refusal, error Retry, and sibling Undo", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    controller = readyController();
    await act(async () => root.render(<Harness />));
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Undo"),
    ).toBe(true);
    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Change work for this chat, currently Current Work"]',
    );
    await act(async () => trigger?.click());
    const search = document.querySelector<HTMLInputElement>('input[type="search"]');
    expect(document.activeElement).toBe(search);

    const nextRow = [...document.querySelectorAll<HTMLButtonElement>("[data-work-choice]")].find(
      (row) => row.textContent?.includes("Next Work"),
    );
    nextRow?.focus();
    controller = readyController("Current");
    await act(async () => root.render(<Harness />));
    expect(document.activeElement).toBe(document.querySelector('input[type="search"]'));

    controller = readyController("", true);
    await act(async () => root.render(<Harness />));
    expect(trigger?.disabled).toBe(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.querySelector('input[type="search"]'));

    controller = {
      ...readyController(),
      catalog: { status: "error" as const, retry },
    };
    await act(async () => root.render(<Harness />));
    expect(document.activeElement?.textContent).toBe("Retry");
    await act(async () => root.unmount());
  });
});
