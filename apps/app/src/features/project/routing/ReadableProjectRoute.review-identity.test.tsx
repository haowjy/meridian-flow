// @vitest-environment jsdom
/** The route's open command lets document identity, not a reused path, decide whether history is replaced. */
import type { ProjectDto } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ContextRemovalRoutePort } from "../context/context-removal-coordinator";
import { useOpenContextRoute } from "./ProjectNavigationContext";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

const projectId = "00000000-0000-4000-8000-000000000020";
const workId = "00000000-0000-4000-8000-000000000021";
/** A live catalog that knows where one document is. */
function catalogPlacing(documentId: string, path: string) {
  return {
    normalized: { generation: "g", appliedRevision: "1", entries: new Map() },
    findPath: () => null,
    findDocument: (id: string) => (id === documentId ? { path } : null),
  };
}

const state = vi.hoisted(() => ({
  lookup: undefined as unknown,
  catalog: null as unknown,
  /** The server's identity answer for a document no tab, address or catalog places. */
  identity: vi.fn(),
  router: null as unknown as {
    history: ReturnType<typeof createMemoryHistory>;
    navigate: (options: { href: string; replace: boolean; state: object }) => Promise<void>;
  },
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => state.router,
  useRouterState: () => ({
    ...state.router.history.location,
    search: { __meridianRawSearch: state.router.history.location.search },
  }),
  useBlocker: () => {},
}));
vi.mock("./work-route", async (original) => ({
  ...(await original<typeof import("./work-route")>()),
  useWorkRoute: () => ({
    routeWork: { status: "absent" },
    workCatalog: {
      status: "ready",
      entries: [],
      creations: new Map(),
      isFetching: false,
      noWork: { id: workId, isNoWork: true },
    },
    rememberedWork: null,
  }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: state.lookup, isError: false }),
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [], isError: false }),
}));
vi.mock("@/client/query/useContextCatalog", async (original) => ({
  ...(await original<typeof import("@/client/query/useContextCatalog")>()),
  useContextCatalogView: () => ({ catalog: state.catalog }),
}));
vi.mock("@/client/api/projects-api", async (original) => ({
  ...(await original<typeof import("@/client/api/projects-api")>()),
  getProjectContextAvailability: (...args: unknown[]) => state.identity(...args),
}));
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({ status: "ready", groups: [] }),
}));
vi.mock("./chat-navigation", () => ({
  useProjectChatNavigation: () => ({ display: { kind: "empty" } }),
  chatSurfaceThreadId: () => null,
  ChatNavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ admitDraftReview() {} }),
}));
vi.mock("../context/use-context-removal-project", () => ({
  useContextRemovalProject: () => ({ selection: { status: "none" } }),
}));
vi.mock("../context/open-project-document", () => ({
  ProjectDocumentNavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ProjectAddressDocument", () => ({ ProjectAddressDocument: () => null }));
vi.mock("../ProjectView", () => ({
  ProjectView: (props: { contextRemovalRoute: ContextRemovalRoutePort }) => {
    openRoute = useOpenContextRoute();
    _removalRoute = props.contextRemovalRoute;
    return null;
  },
}));

let _removalRoute: ContextRemovalRoutePort | undefined;
let openRoute: ReturnType<typeof useOpenContextRoute>;
const open: NonNullable<typeof openRoute> = (...args) => {
  if (!openRoute) throw new Error("The route's open command is not mounted");
  return openRoute(...args);
};

/** The route at `address`, resolved to `documentId`, with that document open as a tab at `tabPath`. */
async function withRoute(
  address: string,
  documentId: string,
  tabPath: string,
  run: (history: ReturnType<typeof createMemoryHistory>) => Promise<void>,
  /** What the live catalog already holds when the route mounts. */
  catalog: unknown = null,
) {
  const history = createMemoryHistory({ initialEntries: [`/p/${projectId}/editor/${address}`] });
  state.router = {
    history,
    navigate: async ({ href, replace, state: next }) => {
      if (replace) history.replace(href, next);
      else history.push(href, next);
    },
  };
  state.lookup = { kind: "current", document: { kind: "available", documentId } };
  state.catalog = catalog;
  state.identity.mockReset();
  const prior = useContextTabsStore.getState();
  useContextTabsStore.setState({
    byProject: {},
    _reviewOverlayByProject: {},
    _workspaceHydrated: true,
  });
  useContextTabsStore.getState().openTab(projectId, {
    kind: "tracked",
    documentId,
    scheme: "manuscript",
    path: tabPath,
    name: tabPath.slice(tabPath.lastIndexOf("/") + 1),
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  });
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
    useContextTabsStore.setState(prior);
    history.destroy();
  }
}

it("opens another document at a reused path as a new history entry", async () => {
  // Document A was renamed and B took its old path. The address shows B; a stale
  // draft row still names A at that path, and A has no tab to say where it went.
  await withRoute(
    "manuscript/a.md?work=",
    "document-b",
    "/a.md",
    async (history) => {
      const before = history.length;
      await open(
        { documentId: "document-a", scheme: "manuscript", path: "/a.md", workId },
        {
          draftId: "draft-a",
          replaceIfSameDocument: true,
        },
      );
      expect(history.length).toBe(before + 1);
      expect(history.location.pathname).toContain("/manuscript/renamed.md");
      expect(history.location.search).toContain("draft=draft-a");
    },
    catalogPlacing("document-a", "/renamed.md"),
  );
});

function openDocumentA(path: string) {
  useContextTabsStore.getState().openTab(projectId, {
    kind: "tracked",
    documentId: "document-a",
    scheme: "manuscript",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  });
}

it("does not let a launch's prepared tab move the document's open tab back to the captured path", async () => {
  await withRoute("manuscript/a.md?work=", "document-b", "/a.md", async () => {
    openDocumentA("/renamed.md");
    await open(
      { documentId: "document-a", scheme: "manuscript", path: "/a.md", workId },
      {
        draftId: "draft-a",
        replaceIfSameDocument: true,
        tab: {
          kind: "tracked",
          documentId: "document-a",
          scheme: "manuscript",
          path: "/a.md",
          name: "a.md",
          editable: true,
          filetype: "markdown",
          schemaType: "document",
          reviewWorkId: workId,
        },
      },
    );
    const tabs = useContextTabsStore.getState().byProject[projectId]?.tabs ?? [];
    expect(tabs.find((tab) => tab.documentId === "document-a")).toMatchObject({
      path: "/renamed.md",
    });
    expect(tabs.find((tab) => tab.documentId === "document-b")).toMatchObject({ path: "/a.md" });
  });
});

const draftLaunch = {
  draftId: "draft-a",
  replaceIfSameDocument: true,
} as const;
const launchOfA = {
  documentId: "document-a",
  scheme: "manuscript",
  path: "/a.md",
  workId,
} as const;

it("fails the launch, and stays where it is, when its document cannot be located", async () => {
  // Navigating to the old path would open B under A's draft.
  await withRoute("manuscript/a.md?work=", "document-b", "/a.md", async (history) => {
    state.identity.mockRejectedValue(new Error("offline"));
    const before = history.location.href;
    const length = history.length;
    const result = await open(launchOfA, draftLaunch);
    expect(result.kind).toBe("failed");
    expect(history.location.href).toBe(before);
    expect(history.length).toBe(length);
  });
});
