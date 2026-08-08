import type { Work } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/features/chat/ChatThreadHeader", () => ({
  ChatThreadTitle: () => <button type="button">A thread</button>,
}));
vi.mock("@/features/chat/ThreadWorkControl", () => ({
  ThreadWorkControl: ({ work }: { work: Work }) => <span>Work: {work.name}</span>,
}));

const { MobileTopBar } = await import("./MobileTopBar");

describe("MobileTopBar chat identity", () => {
  it("shows the resolved Work as an inert fact", async () => {
    await withReactRoot(
      <MobileTopBar
        activeScreen="chat"
        projectId="project-1"
        activeThreadId="thread-1"
        activeWork={{ name: "The Jade Path" } as Work}
        onSelectThread={() => undefined}
        onOpenDrawer={() => undefined}
      />,
      () => {
        expect(document.querySelector("header")?.textContent).toContain("Work: The Jade Path");
        expect(
          [...document.querySelectorAll("button")].map((button) => button.textContent),
        ).not.toContain("Work: The Jade Path");
      },
    );
  });
});
