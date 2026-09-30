// @vitest-environment jsdom
/** An archived Work is view-only: one notice with Unarchive, no inline edits, actions disabled. */
import type { Work } from "@meridian/contracts/works";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AddressableWork } from "@/client/query/useWorks";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ProjectRouteCommands } from "../routing/project-route";
import { WorkDetailScreen } from "./WorkDetailScreen";

const { unarchive } = vi.hoisted(() => ({ unarchive: vi.fn(async () => null) }));

vi.mock("@/client/query/work-command-store", () => ({
  useWorkMutations: () => ({ update: vi.fn(), archive: vi.fn(), unarchive }),
}));
vi.mock("@/client/query/work-command-selectors", () => ({
  useWorkCommandFailures: () => new Map(),
}));
vi.mock("../routing/ProjectNavigationContext", () => ({ useProjectLeaveGuard: () => undefined }));
vi.mock("@/client/query/useProjectChatFeed", () => ({
  useProjectChatFeed: () => ({
    isPending: false,
    isError: false,
    data: { pages: [] },
    items: [],
    hasNextPage: false,
    isPlaceholderData: false,
  }),
}));
vi.mock("../chat-list/useChatRowCommands", () => ({
  useChatRowCommands: () => ({
    onFavorite: vi.fn(),
    onDelete: vi.fn(),
    deleteFailure: null,
    retryDelete: vi.fn(),
    deleteDialog: null,
  }),
}));
vi.mock("../routing/chat-navigation", () => ({
  useChatNavigation: () => ({ openChat: vi.fn(), openNewChat: vi.fn() }),
}));
vi.mock("../chat-index/ChatIndex", () => ({ NextPage: () => null }));
vi.mock("../chat-index/ChatIndexList", () => ({ ChatIndexList: () => null }));

const ARCHIVED = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "project-1",
  createdByUserId: "user-1",
  name: "Tournament arc",
  slug: "tournament-arc",
  isNoWork: false,
  goal: "Draft chapters 12 to 15.",
  status: null,
  archivedAt: "2026-09-02T00:00:00.000Z",
  aiWriteMode: "direct",
  entityRevision: "1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  lastActivityAt: "2026-09-02T00:00:00.000Z",
  deletedAt: null,
} as unknown as AddressableWork;

const buttons = () => [...document.querySelectorAll("button")];
const buttonNamed = (label: string) =>
  buttons().find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );

function renderPage(work: Work) {
  const commands = { workView: "chats", setWorkView: vi.fn() } as unknown as ProjectRouteCommands;
  return (
    <WorkDetailScreen
      projectId="project-1"
      work={work as AddressableWork}
      routeCommands={commands}
    />
  );
}

describe("an archived Work page", () => {
  it("shows one notice, a plain title and goal, and New chat disabled in place", async () => {
    await withReactRoot(renderPage(ARCHIVED), async () => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("This Work is archived.");
      expect(document.querySelector("h1 button")).toBeNull();
      expect(document.querySelector("h1")?.textContent).toBe("Tournament arc");
      expect(text).toContain("Draft chapters 12 to 15.");
      expect(buttonNamed("Edit goal")).toBeUndefined();
      expect(buttonNamed("New chat")?.disabled).toBe(true);
      await act(async () => buttonNamed("Unarchive")?.click());
      expect(unarchive).toHaveBeenCalledWith({ workId: ARCHIVED.id });
    });
  });
});
