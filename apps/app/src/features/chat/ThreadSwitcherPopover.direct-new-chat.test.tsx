// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const createProjectThread = vi.fn();
const invalidateProjectThreadData = vi.fn();
const invalidateWorkThreads = vi.fn();

vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/api/projects-api", () => ({ createProjectThread }));
vi.mock("@/client/query/project-invalidation", () => ({
  invalidateProjectThreadData,
  invalidateWorkThreads,
}));
vi.mock("@/client/stores", () => ({
  useThreadStore: (selector: (state: { now: number }) => unknown) => selector({ now: 0 }),
}));
vi.mock("@/features/project/data/project-thread-groups", () => ({
  useProjectThreadGroups: () => ({
    workItems: [],
    primaryThreads: [],
    threadById: new Map(),
    ungroupedThreads: [],
  }),
}));

const { ThreadSwitcherPopover } = await import("./ThreadSwitcherPopover");

function buttonNamed(name: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === name,
  );
}
afterEach(() => vi.clearAllMocks());

describe("thread switcher New chat", () => {
  it("closes the switcher and opens creation without creating or selecting a thread", async () => {
    const onNewChat = vi.fn();
    const onSelectThread = vi.fn();
    await withReactRoot(
      <ThreadSwitcherPopover
        projectId="project-1"
        activeThreadId="thread-0"
        title="Existing chat"
        onSelectThread={onSelectThread}
        onNewChat={onNewChat}
        onRename={vi.fn()}
      />,
      async () => {
        const trigger = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
        await act(async () => trigger?.click());
        const newChat = buttonNamed("New chat");
        expect(newChat).toBeDefined();
        await act(async () => newChat?.click());
        expect(onNewChat).toHaveBeenCalledTimes(1);
        expect(onSelectThread).not.toHaveBeenCalled();
        expect(createProjectThread).not.toHaveBeenCalled();
        expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      },
    );
  });
});
