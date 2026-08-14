/** Semantic and intrinsic-structure regressions for chat titles across hosts. */
// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileTopBar } from "@/features/project/mobile/MobileTopBar";
import { ThreadSwitcherPopover } from "./ThreadSwitcherPopover";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/stores", () => ({
  announce: vi.fn(),
  useThreadStore: (selector: (state: { now: string }) => unknown) =>
    selector({ now: "2026-01-01T00:00:00.000Z" }),
}));
vi.mock("@/features/project/data/project-thread-groups", () => ({
  useProjectThreadGroups: () => ({
    workItems: [],
    primaryThreads: [],
    threadById: new Map(),
    ungroupedThreads: [],
  }),
}));
vi.mock("@/features/project/chat/use-create-chat", () => ({
  useCreateChat: () => ({ createChat: vi.fn(), creating: false, createError: null }),
}));
vi.mock("@/client/query/useRenameThread", () => ({ useRenameThread: () => vi.fn() }));

let cleanup: (() => void) | undefined;

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return host;
}

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe("thread title host semantics", () => {
  it("names the switch action with the current short title and keeps one shrinking title child", () => {
    const host = render(
      <ThreadSwitcherPopover
        projectId="project-1"
        activeThreadId="thread-1"
        title="Chapter 1"
        onSelectThread={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Switch chat, currently Chapter 1"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.children).toHaveLength(2);
    expect(trigger?.children[0]?.textContent).toBe("Chapter 1");
    expect(trigger?.children[0]?.getAttribute("class")).toContain("min-w-0 flex-1");
    expect(
      Array.from(trigger?.children ?? []).filter((child) => child.classList.contains("flex-1")),
    ).toHaveLength(1);
    expect(trigger?.children[1]?.tagName).toBe("svg");
  });

  it("does not reserve a phantom trailing mobile action when none is supplied", () => {
    const host = render(
      <MobileTopBar
        activeScreen="home"
        projectId="project-1"
        activeThreadId={null}
        onSelectThread={vi.fn()}
        onOpenDrawer={vi.fn()}
        title="Home"
      />,
    );
    const row = host.querySelector("header > div");
    expect(row?.children).toHaveLength(2);
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector('button[aria-label="Open navigation"]')).not.toBeNull();
  });
});
