// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const createChat = vi.fn();
let createError: Error | null = null;
let selectCreatedThread: ((threadId: string) => void) | null = null;

vi.mock("@lingui/core/macro", () => ({
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/client/stores", () => ({
  useThreadStore: (selector: (state: { now: number }) => unknown) => selector({ now: 0 }),
}));
vi.mock("@/features/project/data/dashboard-data", () => ({
  useProjectThreadGroups: () => ({
    workItems: [],
    primaryThreads: [],
    threadById: new Map(),
    ungroupedThreads: [],
  }),
}));
vi.mock("@/features/project/chat/use-create-chat", () => ({
  useCreateChat: (_projectId: string, onSelect: (threadId: string) => void) => {
    selectCreatedThread = onSelect;
    return { createChat, creating: false, createError };
  },
}));

const { ThreadSwitcherPopover } = await import("./ThreadSwitcherPopover");

describe("thread switcher New chat", () => {
  it("stays open for failure and closes only after successful selection", async () => {
    createError = new Error("Could not create chat");
    const onSelectThread = vi.fn();
    const renderSwitcher = () => (
      <ThreadSwitcherPopover
        projectId="project-1"
        activeThreadId="thread-0"
        title="Existing chat"
        onSelectThread={onSelectThread}
        onRename={vi.fn()}
      />
    );

    await withReactRoot(renderSwitcher(), async () => {
      act(() => document.querySelector<HTMLButtonElement>("button")?.click());
      const newChat = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent === "New chat",
      );
      act(() => newChat?.click());
      expect(createChat).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).not.toContain("Choose a Work for this chat");

      expect(document.body.textContent).toContain("Could not create chat");
      act(() => selectCreatedThread?.("thread-1"));
      expect(onSelectThread).toHaveBeenCalledWith("thread-1");
      expect(document.body.textContent).not.toContain("Could not create chat");
    });
  });
});
