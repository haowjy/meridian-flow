import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/features/chat/ChatThreadHeader", () => ({
  ChatThreadTitle: ({ threadId }: { threadId: string }) => (
    <button type="button">{threadId}</button>
  ),
}));
vi.mock("./shell/PaneHeader", () => ({
  PaneHeader: ({ title }: { title: React.ReactNode }) => <header>{title}</header>,
}));

const { ChatPaneController } = await import("./ChatPaneController");

describe("ChatPaneController chat identity", () => {
  it("keeps Work controls out of the header when the selected chat changes", async () => {
    let select: ((next: string) => void) | null = null;
    function Harness() {
      const [active, setActive] = useState("thread-a");
      select = setActive;
      return (
        <ChatPaneController
          projectId="project-1"
          threadId={active}
          sidebarToggle={{ open: true, label: "sidebar", onExpand: () => undefined }}
          contextToggle={{ open: true, label: "context", onExpand: () => undefined }}
          onSelectThread={() => undefined}
        />
      );
    }

    await withReactRoot(<Harness />, async () => {
      expect(document.body.textContent).not.toContain("Work: Revision A");
      expect(buttons().some((button) => button.textContent?.includes("Revision A"))).toBe(false);

      await act(async () => {
        select?.("thread-b");
      });
      expect(document.body.textContent).not.toContain("Work: Revision B");
      expect(document.body.textContent).not.toContain("Revision A");
      expect(buttons().some((button) => button.textContent?.includes("Revision B"))).toBe(false);
    });
  });
});

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")];
}
