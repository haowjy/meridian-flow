// @vitest-environment jsdom

import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const mocks = vi.hoisted(() => ({
  drafts: { status: "success", groups: [] as unknown[], refetch: vi.fn() },
  scratch: {
    tree: { kind: "dir", name: "", path: "", children: [] as unknown[] },
    isError: false,
    refetch: vi.fn(),
  },
  uploads: {
    tree: { kind: "dir", name: "", path: "", children: [] as unknown[] },
    isError: false,
    refetch: vi.fn(),
  },
  chats: {
    threads: [] as unknown[],
    isError: false,
    refetch: vi.fn(),
    nextPageIdentity: null,
    isFetchingNextPage: false,
    fetchNextPageFor: vi.fn(),
    setFavorite: vi.fn(async () => true),
    getCommandState: vi.fn(() => ({ pending: false, error: null })),
  },
  metadata: {
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    mutate: vi.fn(),
  },
  lifecycle: {
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
    mutate: vi.fn(),
  },
  catalog: {
    works: null,
    isError: true,
    isFetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@lingui/react", () => ({ useLingui: () => ({ i18n: { locale: "en-US" } }) }));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle", proceed: vi.fn(), reset: vi.fn() }),
}));
vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: ({ startIndex, endIndex }: { startIndex: number; endIndex: number }) =>
    Array.from({ length: endIndex - startIndex + 1 }, (_, index) => startIndex + index),
  useVirtualizer: ({ count, scrollMargin = 0 }: { count: number; scrollMargin?: number }) => ({
    options: { scrollMargin },
    getTotalSize: () => count * 52,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 52 })),
    measureElement: () => {},
  }),
}));
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => mocks.drafts,
  activeWorkDraftGroups: (groups: unknown[]) => groups,
}));
vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: (_projectId: string, scheme: "scratch" | "uploads") => mocks[scheme],
}));
vi.mock("@/client/query/useWorkThreads", () => ({ useWorkThreads: () => mocks.chats }));
vi.mock("@/client/query/useProjectChatUserState", () => ({
  useProjectChatUserState: (_projectId: string, item: unknown) => ({
    item,
    favorite: { pending: false },
  }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => mocks.catalog,
  useWorkMutations: () => ({
    update: mocks.metadata,
    archive: mocks.lifecycle,
    unarchive: mocks.lifecycle,
    delete: mocks.lifecycle,
    isPending: mocks.lifecycle.isPending,
    error: mocks.lifecycle.error,
  }),
}));

const { WorkDetailScreen } = await import("./WorkDetailScreen");
const { WorkScreen } = await import("./WorkScreen");
const { focusAfterDelete } = await import("./work-focus-intent");

describe("WorkDetailScreen resource boundaries", () => {
  beforeEach(() => vi.clearAllMocks());
  it("keeps a catalog-error detail URL until retry can recover the archived Work", async () => {
    const commands = routeCommands();
    await withReactRoot(
      <WorkScreen
        {...props({ routeCommands: commands, routeWork: { status: "catalog-error" } })}
      />,
      () => {
        expect(document.querySelector("[role=alert]")?.textContent).toContain("Work couldn’t load");
        click("Retry Work");
        expect(mocks.catalog.refetch).toHaveBeenCalledOnce();
        expect(commands.closeWork).not.toHaveBeenCalled();
        expect(commands.openWork).not.toHaveBeenCalled();
      },
    );
    await withReactRoot(
      <WorkScreen
        {...props({
          routeCommands: commands,
          routeWork: { status: "present", work: fixture({ status: "archived" }) },
        })}
      />,
      () => {
        expect(document.body.textContent).toContain("Archived");
        expect(document.body.textContent).toContain("Work A");
      },
    );
  });

  it("retries each failed resource independently", async () => {
    mocks.drafts.status = "error";
    mocks.scratch.isError = true;
    mocks.uploads.isError = true;
    mocks.chats.isError = true;
    await withReactRoot(<WorkDetailScreen {...props()} work={fixture()} />, () => {
      for (const label of [
        "Retry Pending drafts",
        "Retry Scratch",
        "Retry Uploads",
        "Retry Associated chats",
      ])
        expect(button(label).className).toContain("pointer:coarse");
      click("Retry Pending drafts");
      click("Retry Scratch");
      click("Retry Uploads");
      click("Retry Associated chats");
      expect(mocks.drafts.refetch).toHaveBeenCalledOnce();
      expect(mocks.scratch.refetch).toHaveBeenCalledOnce();
      expect(mocks.uploads.refetch).toHaveBeenCalledOnce();
      expect(mocks.chats.refetch).toHaveBeenCalledOnce();
      expect(document.querySelectorAll("[role=alert]")).toHaveLength(4);
    });
  });

  it("opens drafts, context resources, and chats through their semantic route boundaries", async () => {
    resetResources();
    mocks.drafts.groups = [
      {
        documentId: "doc-1",
        documentName: "Chapter One",
        contextPath: "/Chapter One.md",
        drafts: [{ status: "active", updatedAt: "2026-08-15T00:00:00Z" }],
      },
    ];
    mocks.chats.threads = [chat("thread-1", "Planning")];
    const commands = routeCommands();
    const openChat = vi.fn();
    await withReactRoot(
      <WorkDetailScreen
        {...props({ routeCommands: commands, onOpenThread: openChat })}
        work={fixture()}
      />,
      () => {
        click("Chapter One");
        click("Open Scratch");
        click("Open Uploads");
        click("Planning");
        expect(commands.openWorkContext).toHaveBeenNthCalledWith(
          1,
          {
            kind: "work-context",
            workId: fixture().id,
            scheme: "manuscript",
            path: "/Chapter One.md",
          },
          { replace: false },
        );
        expect(commands.openWorkContext).toHaveBeenNthCalledWith(
          2,
          {
            kind: "work-context",
            workId: fixture().id,
            scheme: "scratch",
          },
          { replace: false },
        );
        expect(commands.openWorkContext).toHaveBeenNthCalledWith(
          3,
          {
            kind: "work-context",
            workId: fixture().id,
            scheme: "uploads",
          },
          { replace: false },
        );
        expect(openChat).toHaveBeenCalledWith("thread-1");
        expect(mocks.metadata.mutateAsync).not.toHaveBeenCalled();
      },
    );
  });

  it("renders the shared row with read-only Work identity and favorite action", async () => {
    resetResources();
    mocks.chats.threads = [chat("thread-1", "Planning")];
    await withReactRoot(<WorkDetailScreen {...props()} work={fixture()} />, async () => {
      expect(document.querySelector('[data-project-chat-row="thread-1"]')).not.toBeNull();
      const workIdentity = [...document.querySelectorAll("span")].find(
        (node) => node.textContent === "Current Work",
      );
      expect(workIdentity?.closest("button, a")).toBeNull();

      await openActions("Actions for Planning");
      await tick();
      await act(async () => menuItem("Add to favorites").click());
      expect(mocks.chats.setFavorite).toHaveBeenCalledWith("thread-1", true);
    });
  });

  it("holds internal detail navigation until the writer discards the active draft", async () => {
    resetResources();
    const commands = routeCommands();
    await withReactRoot(
      <WorkDetailScreen {...props({ routeCommands: commands })} work={fixture()} />,
      async () => {
        click("Add a goal");
        change(textarea(), "Unsaved goal");
        click("Open Scratch");
        expect(commands.openWorkContext).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("Save metadata changes?");
        click("Discard changes");
        await tick();
        expect(commands.openWorkContext).toHaveBeenCalledOnce();
        expect(mocks.metadata.mutateAsync).not.toHaveBeenCalled();
      },
    );
  });

  it("exposes focusable entry identity and coarse-pointer action contracts", async () => {
    resetResources();
    const longName =
      "A very long Work name that must wrap safely on a narrow phone without pushing actions outside the viewport";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    await withReactRoot(
      <WorkDetailScreen {...props()} work={fixture({ name: longName })} />,
      () => {
        expect(document.activeElement?.textContent).toBe(longName);
        expect(button("All Work").className).toContain("pointer:coarse");
        expect(button("Manage Work").className).toContain("pointer:coarse");
        expect(button("Edit Work name").className).toContain("pointer:coarse");
        const heading = document.querySelector("h1");
        expect(heading?.closest("button")).toBeNull();
        expect(heading?.className).toContain("break-words");
        expect(heading?.parentElement?.className).toContain("min-w-0");
      },
    );
  });

  it("renders a bounded truthful Scratch and Uploads discovery preview", async () => {
    resetResources();
    mocks.scratch.tree.children = [
      { kind: "dir", name: "Notes", path: "/Notes", children: [] },
      { kind: "file", name: "beats.md", path: "/beats.md" },
      { kind: "file", name: "scene.md", path: "/scene.md" },
      { kind: "file", name: "extra.md", path: "/extra.md" },
    ];
    await withReactRoot(<WorkDetailScreen {...props()} work={fixture()} />, () => {
      expect(document.body.textContent).toContain("Notes");
      expect(document.body.textContent).toContain("beats.md");
      expect(document.body.textContent).toContain("1 more item");
      expect(document.body.textContent).not.toContain("extra.md");
    });
  });

  it("chooses next, previous, then New Work focus after deletion", () => {
    const first = fixture({ id: "work-a" });
    const middle = fixture({ id: "work-b" });
    const last = fixture({ id: "work-c" });
    expect(focusAfterDelete([first, middle, last], middle.id)).toEqual({
      kind: "work",
      workId: last.id,
    });
    expect(focusAfterDelete([first, middle], middle.id)).toEqual({
      kind: "work",
      workId: first.id,
    });
    expect(focusAfterDelete([middle], middle.id)).toEqual({ kind: "new-work" });
  });
});

function resetResources() {
  mocks.drafts.status = "success";
  mocks.drafts.groups = [];
  mocks.scratch.tree = { kind: "dir", name: "", path: "", children: [] };
  mocks.scratch.isError = false;
  mocks.uploads.tree = { kind: "dir", name: "", path: "", children: [] };
  mocks.uploads.isError = false;
  mocks.chats.threads = [];
  mocks.chats.isError = false;
}
function chat(id: string, title: string) {
  return {
    id,
    title,
    work: { id: "current-work", title: "Current Work" },
    lastMessagePreview: "Keep climbing.",
    lastActivityAt: "2026-08-15T00:00:00.000000Z",
    attention: "none" as const,
    isFavorite: false,
  };
}
function props(overrides: Record<string, unknown> = {}) {
  const workId = parseRequestId(fixture().id);
  if (!workId) throw new Error("invalid fixture Work ID");
  return {
    projectId: "project-1",
    routeWork: { status: "present", workId, work: fixture() } as const,
    routeCommands: routeCommands(),
    onOpenThread: vi.fn(),
    ...overrides,
  };
}
function routeCommands() {
  return {
    openHome: vi.fn(),
    openChat: vi.fn(),
    openDockThread: vi.fn(),
    openWork: vi.fn(),
    workHref: vi.fn(() => "?screen=work"),
    closeWork: vi.fn(),
    openWorkContext: vi.fn(),
  };
}
function fixture(overrides: Partial<Work> = {}): Work {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Work A",
    slug: "work-a",
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    aiWriteMode: "draft",
    unpushedChangeCount: 0,
    lastActivityAt: "2026-08-15T00:00:00.000Z",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}
function button(label: string): HTMLButtonElement {
  const node = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!(node instanceof window.HTMLButtonElement)) throw new Error(`missing ${label}`);
  return node;
}
function menuItem(label: string): HTMLElement {
  const node = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === label,
  );
  if (!(node instanceof window.HTMLElement)) throw new Error(`missing ${label}`);
  return node;
}
async function openActions(label: string) {
  const trigger = button(label);
  await act(async () => {
    const PointerEventConstructor = window.PointerEvent ?? window.MouseEvent;
    trigger.dispatchEvent(
      new PointerEventConstructor("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      } as PointerEventInit),
    );
    trigger.click();
  });
}
function click(label: string) {
  act(() => button(label).click());
}
function textarea() {
  const node = document.querySelector("textarea");
  if (!(node instanceof window.HTMLTextAreaElement)) throw new Error("missing textarea");
  return node;
}
function change(node: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function tick() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
