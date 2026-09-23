// @vitest-environment jsdom
/**
 * Component coverage for the thread-title rename control: a definitive
 * rejection shows a reachable inline Retry, and the rename field caps input at
 * the contract maximum so Retry cannot resubmit a too-long refusal.
 */
import { THREAD_TITLE_MAX_LENGTH } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0], message: strings[0] }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const mocks = vi.hoisted(() => ({ view: {} as Record<string, unknown> }));
vi.mock("@/client/query/useRenameThread", () => ({
  useRenameThread: () => mocks.view,
}));
vi.mock("@/features/project/data/project-thread-groups", () => ({
  useProjectThreadGroups: () => ({
    threadById: new Map([[THREAD_ID, { id: THREAD_ID, projectId: PROJECT_ID, title: "Original" }]]),
  }),
}));
vi.mock("@/features/project/routing/ProjectNavigationContext", () => ({
  useOpenNewChatRoute: () => () => undefined,
}));
vi.mock("./ThreadSwitcherPopover", () => ({
  ThreadSwitcherPopover: ({ onRename }: { onRename: () => void }) => (
    <button type="button" data-role="switcher" onClick={onRename}>
      switch
    </button>
  ),
}));

import { ChatThreadTitle } from "./ChatThreadHeader";

const PROJECT_ID = "project-1";
const THREAD_ID = "thread-1";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("ChatThreadTitle rename control", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    mocks.view = {};
  });

  async function render() {
    await act(async () =>
      root.render(
        <ChatThreadTitle projectId={PROJECT_ID} threadId={THREAD_ID} onSelectThread={vi.fn()} />,
      ),
    );
  }

  it("renders a reachable Retry on a definitive rejection", async () => {
    const retry = vi.fn();
    mocks.view = {
      pending: false,
      error: new Error("refused"),
      reconciling: false,
      submit: vi.fn(),
      retry,
    };
    await render();

    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(button).not.toBeUndefined();
    expect(button?.getAttribute("type")).toBe("button");

    await act(async () => button?.click());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("caps the rename field at the contract maximum and ignores blank titles", async () => {
    const submit = vi.fn();
    mocks.view = {
      pending: false,
      error: undefined,
      reconciling: false,
      submit,
      retry: vi.fn(),
    };
    await render();

    const switcher = document.querySelector("[data-role='switcher']");
    await act(async () => (switcher as HTMLButtonElement | null)?.click());

    const input = document.querySelector<HTMLInputElement>("input[aria-label='Rename chat']");
    expect(input).not.toBeNull();
    expect(input?.maxLength).toBe(THREAD_TITLE_MAX_LENGTH);

    // A blank draft never dispatches.
    await act(async () => {
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "   ");
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      }
    });
    await act(async () => input?.blur());
    expect(submit).not.toHaveBeenCalled();

    // A trimmed title dispatches once.
    await act(async () =>
      (document.querySelector("[data-role='switcher']") as HTMLButtonElement | null)?.click(),
    );
    const second = document.querySelector<HTMLInputElement>("input[aria-label='Rename chat']");
    await act(async () => {
      if (second) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(second, "  New title  ");
        second.dispatchEvent(new window.Event("input", { bubbles: true }));
      }
    });
    await act(async () => second?.blur());
    expect(submit).toHaveBeenCalledWith("New title");
  });
});
