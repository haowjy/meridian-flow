import type { Work } from "@meridian/contracts/works";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";

const createChat = vi.fn();
const resetCreateError = vi.fn();
const refetch = vi.fn();
let createError: Error | null;
let worksState: {
  works: Work[] | null;
  currentWorkId: string | null;
  isError: boolean;
  isFetching: boolean;
};

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ ...worksState, refetch }),
}));
vi.mock("./use-create-chat", () => ({
  useCreateChat: () => ({
    createChat,
    creating: false,
    createError,
    resetCreateError,
  }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const { NewChatDialog } = await import("./NewChatDialog");

describe("NewChatDialog Work eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createError = null;
    worksState = {
      works: [
        work("active-a", "Active A", "active"),
        work("archived-b", "Archived B", "archived"),
        work("archived-current", "Archived Current", "archived"),
      ],
      currentWorkId: "archived-current",
      isError: false,
      isFetching: false,
    };
  });

  it("keeps the archived current Work eligible without offering other archived Works", async () => {
    await withReactRoot(
      <NewChatDialog
        projectId="project-1"
        open
        onOpenChange={() => undefined}
        onSelectThread={() => undefined}
      />,
      () => {
        expect(document.body.textContent).toContain("Active A");
        expect(document.body.textContent).toContain("Archived Current");
        expect(document.body.textContent).not.toContain("Archived B");
        expect(buttonContaining("Archived Current").textContent).toContain("Current Work");
        expect(buttonContaining("Active A").textContent).not.toContain("Current Work");
        buttonContaining("Archived Current").click();
        expect(createChat).toHaveBeenCalledWith("archived-current");
      },
    );
  });

  it("announces a failed creation and leaves the Work choice available for retry", async () => {
    createError = new Error("Could not create chat");
    await withReactRoot(
      <NewChatDialog
        projectId="project-1"
        open
        onOpenChange={() => undefined}
        onSelectThread={() => undefined}
      />,
      () => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Could not create chat",
        );
        buttonContaining("Active A").click();
        expect(createChat).toHaveBeenCalledWith("active-a");
      },
    );
  });
});

function work(id: string, name: string, status: Work["status"]): Work {
  return {
    id,
    projectId: "project-1",
    createdByUserId: "user-1",
    name,
    goal: null,
    description: null,
    status,
    archivedAt: status === "archived" ? "2026-08-01T00:00:00.000Z" : null,
    aiWriteMode: "draft",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
  } as Work;
}

function buttonContaining(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof window.HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return button;
}
