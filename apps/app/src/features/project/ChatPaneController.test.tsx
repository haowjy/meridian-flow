import type { Work } from "@meridian/contracts/works";
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
vi.mock("@/features/chat/ThreadWorkControl", () => ({
  ThreadWorkControl: ({ work }: { work: Work }) => <span>Work: {work.name}</span>,
}));
vi.mock("./shell/PaneHeader", () => ({
  PaneHeader: ({ title }: { title: React.ReactNode }) => <header>{title}</header>,
}));

const { ChatPaneController } = await import("./ChatPaneController");

describe("ChatPaneController Work fact", () => {
  it("shows the resolved Work as inert text and changes it with the selected chat", async () => {
    let select: ((next: { threadId: string; work: Work }) => void) | null = null;
    function Harness() {
      const [active, setActive] = useState({
        threadId: "thread-a",
        work: workFixture("work-a", "Revision A"),
      });
      select = setActive;
      return (
        <ChatPaneController
          projectId="project-1"
          threadId={active.threadId}
          activeWork={active.work}
          sidebarToggle={{ open: true, label: "sidebar", onExpand: () => undefined }}
          contextToggle={{ open: true, label: "context", onExpand: () => undefined }}
          onSelectThread={() => undefined}
        />
      );
    }

    await withReactRoot(<Harness />, async () => {
      expect(document.body.textContent).toContain("Work: Revision A");
      expect(buttons().some((button) => button.textContent?.includes("Revision A"))).toBe(false);

      await act(async () => {
        select?.({ threadId: "thread-b", work: workFixture("work-b", "Revision B") });
      });
      expect(document.body.textContent).toContain("Work: Revision B");
      expect(document.body.textContent).not.toContain("Revision A");
      expect(buttons().some((button) => button.textContent?.includes("Revision B"))).toBe(false);
    });
  });
});

function workFixture(id: string, name: string): Work {
  return {
    id,
    projectId: "project-1",
    createdByUserId: "user-1",
    name,
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    aiWriteMode: "draft",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
  } as Work;
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")];
}
