// @vitest-environment jsdom
/** Project-route lifetime regressions for cold navigation and seeded refreshes. */

import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ListWorksResponse } from "@meridian/contracts/protocol";
import type { WorkCatalogEntry } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLoaderData,
} from "@tanstack/react-router";
import { act, useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useWorks } from "@/client/query/useWorks";
import { ThreadStoreProvider } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { testWorkSlug } from "@/test-support/work-slug";
import { Route as ProductionProjectRoute, ProjectIdentityBoundary } from "../p/$projectSlug";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: import("react").ReactNode }) => children,
}));

const api = vi.hoisted(() => ({ listWorks: vi.fn() }));
const activePublishers = new Set<string>();
vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  listProjectWorks: api.listWorks,
}));
vi.mock("@/features/project/ProjectView", () => ({ ProjectView: () => null }));
vi.mock("../../_authenticated", () => ({
  Route: { useLoaderData: () => ({ user: { workingSetSyncEnabled: true } }) },
}));

afterEach(() => activePublishers.clear());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const WORK: WorkCatalogEntry = {
  id: "work-b",
  projectId: "project-b",
  createdByUserId: "user-1",
  name: "Work B",
  slug: testWorkSlug("work-b"),
  goal: null,
  description: null,
  status: "active",
  archivedAt: null,
  aiWriteMode: "direct",
  entityRevision: "1",
  unpushedChangeCount: 0,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  lastActivityAt: "2026-08-28T00:00:00.000Z",
  deletedAt: null,
};

it.each([
  false,
  true,
])("releases A during cold B loading, failure and retry (failure: %s)", async (fail) => {
  let rejectB = fail;
  const coldB = deferred<void>();
  const rootRoute = createRootRoute({ component: ProjectOutlet });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/p/$projectSlug",
    loader: async ({ params }) => {
      if (params.projectSlug === "project-b") {
        await coldB.promise;
        if (rejectB) throw new Error("Project lookup offline");
      }
      return { projectSlug: params.projectSlug };
    },
    pendingComponent: ProductionProjectRoute.options.pendingComponent,
    errorComponent: ProductionProjectRoute.options.errorComponent,
    pendingMs: ProductionProjectRoute.options.pendingMs,
    pendingMinMs: ProductionProjectRoute.options.pendingMinMs,
    component: ProjectHost,
  });
  const routeTree = rootRoute.addChildren([projectRoute]);
  expect(ProductionProjectRoute.options.pendingMs).toBe(0);
  expect(ProductionProjectRoute.options.pendingMinMs).toBe(0);
  const history = createMemoryHistory({ initialEntries: ["/p/project-a"] });
  const router = createRouter({ routeTree, history, defaultPendingMinMs: 0 });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  await router.load();
  const testI18n = setupI18n({
    locale: "en",
    messages: { en: { "Loading project…": "Loading project…" } },
  });

  await withReactRoot(
    <I18nProvider i18n={testI18n}>
      <RouterProvider router={router} />
    </I18nProvider>,
    async () => {
      vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const hostA = document.querySelector('[data-project-host="project-a"]');
      const publisherA = document.querySelector('[data-context-publisher="project-a"]');
      expect(hostA).not.toBeNull();
      expect(publisherA).not.toBeNull();
      expect(activePublishers).toEqual(new Set(["project-a"]));

      let navigation!: Promise<void>;
      await act(async () => {
        navigation = router.navigate({
          to: "/p/$projectSlug",
          params: { projectSlug: "project-b" },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(document.querySelector('main[role="status"]')?.textContent).toContain(
        "Loading project",
      );
      expect(router.state.location.pathname).toBe("/p/project-b");
      expect(hostA?.isConnected).toBe(false);
      expect(publisherA?.isConnected).toBe(false);
      expect(activePublishers.size).toBe(0);
      expect(
        document.querySelector('[data-project-host]:not([style*="display: none"])'),
      ).toBeNull();

      await act(async () => {
        coldB.resolve();
        await navigation;
      });
      if (fail) {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain("couldn’t load");
        expect(activePublishers.size).toBe(0);
        expect(hostA?.isConnected).toBe(false);
        rejectB = false;
        await act(async () => {
          await router.invalidate();
        });
      }
      expect(document.querySelector('[data-project-host="project-b"]')).not.toBeNull();
      expect(document.querySelector('[data-context-publisher="project-b"]')).not.toBeNull();
      expect(activePublishers).toEqual(new Set(["project-b"]));
    },
  );
});

it("keeps the exact seeded live host mounted while its Work catalog refresh is held", async () => {
  const refresh = deferred<ListWorksResponse>();
  api.listWorks.mockReturnValue(refresh.promise);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(projectQueryKeys.works("project-b"), worksSnapshot("1"));

  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <ThreadStoreProvider now={Date.now()}>
        <SeededProjectHost projectId="project-b" />
      </ThreadStoreProvider>
    </QueryClientProvider>,
    async () => {
      const host = document.querySelector('[data-project-host="project-b"]');
      const publisher = document.querySelector('[data-context-publisher="project-b"]');
      expect(host).not.toBeNull();
      expect(publisher).not.toBeNull();

      await act(async () => {
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.works("project-b") });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.querySelector('[data-refreshing="true"]')).not.toBeNull();
      expect(host?.isConnected).toBe(true);
      expect(publisher?.isConnected).toBe(true);
      expect(document.querySelector('[data-project-host="project-b"]')).toBe(host);
      expect(document.querySelector('[data-context-publisher="project-b"]')).toBe(publisher);

      await act(async () => refresh.resolve(worksSnapshot("2")));
      expect(document.querySelector('[data-project-host="project-b"]')).toBe(host);
      expect(document.querySelector('[data-context-publisher="project-b"]')).toBe(publisher);
    },
  );
});

function worksSnapshot(authorityRevision: string): ListWorksResponse {
  return {
    projectId: "project-b",
    catalogGeneration: "generation-b",
    authorityRevision,
    requestId: `request-${authorityRevision}`,
    works: [WORK],
  };
}

function ProjectHost() {
  const { projectSlug } = useLoaderData({ strict: false }) as { projectSlug: string };
  return (
    <ProjectIdentityBoundary slug={projectSlug}>
      <PublishingHost projectId={projectSlug} />
    </ProjectIdentityBoundary>
  );
}
function PublishingHost({ projectId }: { projectId: string }) {
  useLayoutEffect(() => {
    activePublishers.add(projectId);
    return () => {
      activePublishers.delete(projectId);
    };
  }, [projectId]);
  return (
    <div data-project-host={projectId}>
      <button type="button" data-context-publisher={projectId}>
        New file
      </button>
    </div>
  );
}

function ProjectOutlet() {
  return <Outlet />;
}

function SeededProjectHost({ projectId }: { projectId: string }) {
  const works = useWorks(projectId);
  if (works.status !== "ready") return null;
  return (
    <div data-project-host={projectId} data-refreshing={works.isFetching}>
      <button type="button" data-context-publisher={projectId}>
        New file
      </button>
    </div>
  );
}
