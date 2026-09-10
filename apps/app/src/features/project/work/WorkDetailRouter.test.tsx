// @vitest-environment jsdom

import { parseRequestId } from "@meridian/contracts/request-id";
import type { Work } from "@meridian/contracts/works";
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testWorkSlug } from "@/test-support/work-slug";

const save = vi.hoisted(() => vi.fn());
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = vi.fn();
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({ status: "success", groups: [], refetch: vi.fn() }),
  activeWorkDraftGroups: (groups: unknown[]) => groups,
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({
    catalog: { root: { entryId: "root" }, files: () => [], children: () => [] },
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/client/query/useWorkThreads", () => ({
  useWorkThreads: () => ({ threads: [], isError: false, refetch: vi.fn() }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorkMutations: () => ({
    update: { mutateAsync: save },
    archive: { mutate: vi.fn() },
    unarchive: { mutate: vi.fn() },
    delete: { mutate: vi.fn() },
    isPending: false,
    error: null,
  }),
}));

const { WorkDetailScreen } = await import("./WorkDetailScreen");

describe("Work detail mounted router blocking", () => {
  beforeEach(() => vi.clearAllMocks());

  it("holds browser Back and resumes that exact history intent after Discard", async () => {
    const history = browserHistory("/collection", "/detail");
    const root = createRootRoute({ component: Outlet });
    const collection = createRoute({
      getParentRoute: () => root,
      path: "/collection",
      component: () => <h1>Collection</h1>,
    });
    const detail = createRoute({
      getParentRoute: () => root,
      path: "/detail",
      component: () => <WorkDetailScreen {...props()} work={fixture()} />,
    });
    const router = createRouter({ routeTree: root.addChildren([collection, detail]), history });

    await mounted(<RouterProvider router={router} />, async () => {
      await tick();
      click("Add a goal");
      change(textarea(), "Unsaved goal");
      await tick();
      await act(async () => router.history.back());
      await tick();
      expect(router.state.location.pathname).toBe("/detail");
      expect(document.body.textContent).toContain("Save metadata changes?");
      click("Discard changes");
      await tick();
      expect(router.state.location.pathname).toBe("/collection");
      expect(document.body.textContent).toContain("Collection");
      expect(save).not.toHaveBeenCalled();
    });
    history.destroy();
  });

  it("holds browser Forward and resumes once after saving succeeds", async () => {
    save.mockImplementation(async (data) => ({ ...fixture(), ...data }));
    const history = browserHistory("/detail", "/collection");
    await goBack(history);
    const root = createRootRoute({ component: Outlet });
    const collection = createRoute({
      getParentRoute: () => root,
      path: "/collection",
      component: () => <h1>Collection</h1>,
    });
    const detail = createRoute({
      getParentRoute: () => root,
      path: "/detail",
      component: () => <WorkDetailScreen {...props()} work={fixture()} />,
    });
    const router = createRouter({ routeTree: root.addChildren([collection, detail]), history });
    await mounted(<RouterProvider router={router} />, async () => {
      await tick();
      click("Add a goal");
      change(textarea(), "Saved goal");
      await tick();
      await act(async () => router.history.forward());
      await tick();
      expect(router.state.location.pathname).toBe("/detail");
      click("Save changes");
      await tick();
      expect(router.state.location.pathname).toBe("/collection");
      expect(save).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledWith({
        workId: fixture().id,
        data: { goal: "Saved goal" },
      });
    });
    history.destroy();
  });
});

function props() {
  const workId = parseRequestId(fixture().id);
  if (!workId) throw new Error("invalid fixture Work ID");
  return {
    projectId: "project-1",
    routeWork: { status: "present", workId, work: fixture() } as const,
    routeCommands: {
      openHome: vi.fn(),
      openChat: vi.fn(),
      openDockThread: vi.fn(),
      openWork: vi.fn(),
      workHref: vi.fn(() => "?screen=work"),
      closeWork: vi.fn(),
      openWorkContext: vi.fn(),
    },
    onOpenThread: vi.fn(),
  };
}
function fixture(): Work {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "project-1",
    createdByUserId: "user-1",
    name: "Work A",
    slug: testWorkSlug("work-a"),
    goal: null,
    description: null,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    aiWriteMode: "draft",
    entityRevision: "1",
    unpushedChangeCount: 0,
    lastActivityAt: "2026-08-15T00:00:00.000Z",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}
function click(label: string) {
  const node = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label,
  );
  if (!(node instanceof window.HTMLButtonElement)) throw new Error(`missing ${label}`);
  act(() => node.click());
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function browserHistory(first: string, second: string) {
  window.history.replaceState({}, "", "/");
  const history = createBrowserHistory({ window });
  history.replace(first);
  history.flush();
  history.push(second);
  history.flush();
  return history;
}
async function goBack(history: ReturnType<typeof createBrowserHistory>) {
  const popped = new Promise<void>((resolve) =>
    window.addEventListener("popstate", () => resolve(), { once: true }),
  );
  history.back();
  await popped;
}
async function mounted(node: React.ReactNode, run: () => Promise<void>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(node));
    await run();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}
