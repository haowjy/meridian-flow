// @vitest-environment jsdom
/** Unresolved Editor opens retain local history and the same tab-lifetime fence as resolved opens. */
import type { ProjectDto } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { type ContextTab, getContextTabs, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useOpenContextRoute, useProjectLeaveGuard } from "./ProjectNavigationContext";
import type { NavigationSettlement } from "./project-navigation";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

const projectId = "00000000-0000-4000-8000-000000000020";
const state = vi.hoisted(() => ({
  router: null as unknown as {
    history: ReturnType<typeof createMemoryHistory>;
    navigate: (options: { href: string; replace: boolean; state: object }) => Promise<void>;
  },
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => state.router,
  useRouterState: () => ({ ...state.router.history.location, search: {} }),
  useBlocker: () => {},
}));
vi.mock("./work-route", async (original) => ({
  ...(await original<typeof import("./work-route")>()),
  useWorkRoute: () => ({
    routeWork: { status: "absent" },
    workCatalog: {
      status: "loading",
      entries: [],
      creations: new Map(),
      isFetching: false,
      noWork: null,
    },
    rememberedWork: null,
  }),
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [], isError: false }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({ catalog: null }),
}));
vi.mock("./chat-navigation", () => ({
  useProjectChatNavigation: () => ({ display: { kind: "empty" } }),
  chatSurfaceThreadId: () => null,
  ChatNavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/account-feature-context", () => ({ useContextRemovalCoordinator: () => ({}) }));
vi.mock("../context/use-context-removal-project", () => ({
  useContextRemovalProject: () => ({ selection: null }),
}));
vi.mock("../context/open-project-document", () => ({
  ProjectDocumentNavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../ProjectView", () => ({
  ProjectView: () => {
    return <Probe />;
  },
}));

let open: ReturnType<typeof useOpenContextRoute>;
let departure: { run(): void; cancel(): void } | undefined;
let dirty = false;
function Probe() {
  open = useOpenContextRoute();
  useProjectLeaveGuard({
    dirty: () => dirty,
    request: (intent) => {
      if (dirty) departure = intent;
      else intent.run();
    },
    cancel: () => {},
  });
  return null;
}

it("opens local content without a Work, but refuses a stale tab after a waiting departure", async () => {
  const history = createMemoryHistory({ initialEntries: [`/p/${projectId}/chats`] });
  state.router = {
    history,
    navigate: async ({
      href,
      replace,
      state: nextState,
    }: {
      href: string;
      replace: boolean;
      state: object;
    }) => {
      if (replace) history.replace(href, nextState);
      else history.push(href, nextState);
    },
  };
  const prior = useContextTabsStore.getState();
  useContextTabsStore.setState({
    byProject: {},
    _reviewOverlayByProject: {},
    _workspaceHydrated: true,
  });
  const local: ContextTab = {
    kind: "new",
    documentId: "local-document",
    name: "New document",
    resourceHandle: "local-resource",
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <ReadableProjectRoute
          project={{ id: projectId } as ProjectDto}
          entryHydration={{ status: "disabled" }}
          user={{ userId: "account" }}
        />
      </QueryClientProvider>,
      async () => {
        let result: NavigationSettlement | undefined;
        await act(async () => {
          result = await open?.(
            { documentId: local.documentId, scheme: "unfiled", path: "" },
            { tab: local },
          );
        });
        expect(result).toEqual({ kind: "applied" });
        expect(history.location.href).toBe(`/p/${projectId}/editor`);
        expect(history.location.state).toMatchObject({
          meridianProjectSelection: {
            version: 2,
            accountId: "account",
            projectId,
            resourceHandle: local.resourceHandle,
          },
        });
        expect(getContextTabs(projectId).tabs.map(({ documentId }) => documentId)).toEqual([
          local.documentId,
        ]);
        expect(getContextTabs(projectId).selectedTabIdByWork).toEqual({});
        dirty = true;
        let pending: ReturnType<NonNullable<typeof open>> | undefined;
        await act(async () => {
          pending = open?.({ documentId: local.documentId, scheme: "unfiled", path: "" });
        });
        expect(departure).toBeDefined();
        const entryKey = history.location.state.__TSR_key;
        await act(async () => {
          useContextTabsStore.setState({
            byProject: { [projectId]: { tabs: [], selectedTabIdByWork: {} } },
          });
          useContextTabsStore.getState().openTab(projectId, local);
          departure?.run();
          result = await pending;
        });
        expect(result).toEqual({ kind: "superseded" });
        expect(history.location.state.__TSR_key).toBe(entryKey);
      },
    );
  } finally {
    dirty = false;
    departure = undefined;
    client.clear();
    useContextTabsStore.setState(prior);
    history.destroy();
  }
});
