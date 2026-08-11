// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const createChat = vi.fn();
let createError: Error | null = null;

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((result, part, index) => result + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("../chat/use-create-chat", () => ({
  useCreateChat: () => ({ createChat, creating: false, createError }),
}));
vi.mock("./chats-overview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chats-overview")>()),
  useChatsOverview: () => ({ rows: [], workCount: 0, loaded: true }),
}));
vi.mock("./WorksManager", () => ({ WorksManager: () => null }));

const { HomeOverviewBody } = await import("./HomeScreen");

afterEach(() => {
  createChat.mockReset();
  createError = null;
});

describe("Home New chat", () => {
  it("creates immediately and keeps failure retry at the invoking surface", async () => {
    createError = new Error("Could not create chat");
    const renderHome = () => (
      <HomeOverviewBody projectId="project-1" onSelectThread={vi.fn()}>
        {() => null}
      </HomeOverviewBody>
    );

    await withReactRoot(renderHome(), async () => {
      const newChat = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "New chat",
      );
      act(() => newChat?.click());
      expect(createChat).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).not.toContain("Choose a Work for this chat");
      expect(document.body.textContent).toContain("Could not create chat");
      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Retry",
      );
      act(() => retry?.click());
      expect(createChat).toHaveBeenCalledTimes(2);
    });
  });
});
