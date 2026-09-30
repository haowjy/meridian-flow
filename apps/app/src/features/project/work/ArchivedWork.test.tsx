// @vitest-environment jsdom
/** An archived Work is view-only: one notice with Unarchive, no inline edits, actions disabled. */
import type { Work } from "@meridian/contracts/works";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import type { AddressableWork } from "@/client/query/useWorks";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ProjectRouteCommands } from "../routing/project-route";
import { WorkDetailScreen } from "./WorkDetailScreen";
import { ScratchFileRow } from "./WorkFileRows";

const { unarchive } = vi.hoisted(() => ({ unarchive: vi.fn(async () => null) }));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Plural: () => null,
}));
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
vi.mock("../dock/use-open-file-in-dock", () => ({ useOpenFileInDock: () => vi.fn() }));
vi.mock("../dock/dock-view-store", () => ({ useDockViewStore: () => false }));

const ARCHIVED = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "project-1",
  createdByUserId: "user-1",
  name: "Tournament arc",
  slug: "tournament-arc",
  isNoWork: false,
  goal: "Draft chapters 12 to 15.",
  status: "archived",
  archivedAt: "2026-09-02T00:00:00.000Z",
  aiWriteMode: "direct",
  entityRevision: "1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  lastActivityAt: "2026-09-02T00:00:00.000Z",
  deletedAt: null,
} as unknown as AddressableWork;

const NOTE = {
  kind: "file",
  entryId: "entry-1",
  parentId: "root",
  documentId: "doc-1",
  name: "beats.md",
  path: "/beats.md",
  uri: "scratch://@tournament-arc/beats.md",
  provisionalName: false,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} as unknown as CatalogFile;

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
      expect(text.indexOf("Tournament arc")).toBeLessThan(text.indexOf("This Work is archived."));
      expect(text.indexOf("This Work is archived.")).toBeLessThan(
        text.indexOf("Draft chapters 12 to 15."),
      );
      expect(buttonNamed("Edit")).toBeUndefined();
      expect(buttonNamed("New chat")?.disabled).toBe(true);
      await act(async () => buttonNamed("Unarchive")?.click());
      expect(unarchive).toHaveBeenCalledWith({ workId: ARCHIVED.id });
    });
  });

  it("offers no Add a goal prompt when the goal is empty", async () => {
    await withReactRoot(renderPage({ ...ARCHIVED, goal: null }), () => {
      expect(document.body.textContent).not.toContain("Add a goal");
    });
  });
});

describe("a Work file row", () => {
  const row = (readOnly: boolean) => (
    <ScratchFileRow
      projectId="project-1"
      workId={ARCHIVED.id}
      file={NOTE}
      siblingNames={[]}
      readOnly={readOnly}
      renaming={readOnly}
      onRename={vi.fn()}
      onDelete={vi.fn()}
    />
  );

  it("offers only opening while its Work is read-only", async () => {
    await withReactRoot(row(true), () => {
      expect(buttonNamed("beats.md")).toBeDefined();
      expect(buttonNamed("Actions")).toBeUndefined();
      expect(document.querySelector("input")).toBeNull();
      // No right-click menu either: the row is not a context-menu trigger.
      expect(document.querySelector("[data-state]")).toBeNull();
    });
  });

  it("keeps Rename and Delete while its Work is active", async () => {
    await withReactRoot(row(false), () => {
      expect(buttonNamed("Actions")).toBeDefined();
    });
  });
});
