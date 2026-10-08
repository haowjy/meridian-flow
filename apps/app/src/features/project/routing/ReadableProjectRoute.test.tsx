// @vitest-environment jsdom
/** Local Editor opens retain history, fence tab lifetimes, and publish placed resource locators. */
import type { ProjectDto } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { type ContextTab, getContextTabs, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useOpenContextRoute, useProjectLeaveGuard } from "./ProjectNavigationContext";
import type { NavigationSettlement } from "./project-navigation";
import type { ProjectRouteCommands } from "./project-route";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

const projectId = "00000000-0000-4000-8000-000000000020";
const workId = "00000000-0000-4000-8000-000000000021";
const state = vi.hoisted(() => ({
  ready: false,
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
      status: state.ready ? "ready" : "loading",
      entries: [],
      creations: new Map(),
      isFetching: false,
      noWork: state.ready ? { id: "00000000-0000-4000-8000-000000000021", isNoWork: true } : null,
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
  ProjectView: (props: {
    activeContextScheme: string;
    activeContextPath: string;
    routeCommands: ProjectRouteCommands;
  }) => {
    displayed = props;
    commands = props.routeCommands;
    return <Probe />;
  },
}));

let displayed: { activeContextScheme: string; activeContextPath: string };
let commands: ProjectRouteCommands;
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

it("preserves local opens and tab lifetime fencing, then publishes the placed Scratch locator", async () => {
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
        // A persisted history pointer can outlive local document materialization.
        // It must not keep publishing the Untitled locator after Scratch placement.
        state.ready = true;
        await act(async () => {
          useContextTabsStore.setState({
            byProject: {
              [projectId]: {
                tabs: [
                  {
                    ...getContextTabs(projectId).tabs[0],
                    kind: "tracked",
                    scheme: "scratch",
                    path: "/note.md",
                    workId,
                    origin: "local-resource",
                    editable: true,
                    filetype: "markdown",
                    schemaType: "document",
                  },
                ],
                selectedTabIdByWork: { [workId]: local.documentId },
              },
            },
          });
        });
        expect(displayed).toMatchObject({
          activeContextScheme: "scratch",
          activeContextPath: "/note.md",
        });
      },
    );
  } finally {
    state.ready = false;
    dirty = false;
    departure = undefined;
    client.clear();
    useContextTabsStore.setState(prior);
    history.destroy();
  }
});

describe("opening a Work's Files tab", () => {
  const otherWork = "00000000-0000-4000-8000-000000000022";
  const chatId = "00000000-0000-4000-8000-000000000023";
  const files = `/p/${projectId}/works/${workId}?view=files`;

  async function fromAddress(
    start: string,
    run: (history: ReturnType<typeof createMemoryHistory>) => Promise<void>,
  ) {
    const history = createMemoryHistory({ initialEntries: [`/p/${projectId}/chats`, start] });
    state.router = {
      history,
      navigate: async ({ href, replace, state: nextState }) => {
        if (replace) history.replace(href, nextState);
        else history.push(href, nextState);
      },
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
        () => run(history),
      );
    } finally {
      client.clear();
      history.destroy();
    }
  }

  it.each([
    ["the Editor", `/p/${projectId}/editor`],
    ["a chat", `/p/${projectId}/chats/${chatId}`],
    ["another Work's page", `/p/${projectId}/works/${otherWork}`],
    ["another Work's Files tab", `/p/${projectId}/works/${otherWork}?view=files`],
  ])("reaches it from %s in one history entry, and Back returns there", async (_name, start) => {
    await fromAddress(start, async (history) => {
      const entries = history.length;
      await act(async () => {
        await commands.openWork(
          { kind: "work-detail", workId: workId as never, view: "files" },
          { replace: false },
        );
      });
      expect(history.location.href).toBe(files);
      expect(history.length).toBe(entries + 1);
      await act(async () => history.back());
      expect(history.location.href).toBe(start);
    });
  });

  it("opens a Work on its chats unless the target names Files", async () => {
    await fromAddress(files.replace(workId, otherWork), async (history) => {
      const target = { kind: "work-detail", workId: workId as never } as const;
      expect(commands.workHref(target)).toBe(`/p/${projectId}/works/${workId}`);
      expect(commands.workHref({ ...target, view: "files" })).toBe(files);
      await act(async () => {
        await commands.openWork(target, { replace: false });
      });
      expect(history.location.href).toBe(`/p/${projectId}/works/${workId}`);
    });
  });
});
