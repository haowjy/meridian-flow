// @vitest-environment jsdom
/** The route's open command lets document identity, not a reused path, decide whether history is replaced. */
import type { ProjectDto } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ContextRemovalRoutePort } from "../context/context-removal-coordinator";
import { resolveWorkspaceRoute } from "../context/context-route-workspace-owner";
import { identityCommitRoute } from "../context/use-identity-commit";
import { useOpenContextRoute } from "./ProjectNavigationContext";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

const projectId = "00000000-0000-4000-8000-000000000020";
const workId = "00000000-0000-4000-8000-000000000021";
const state = vi.hoisted(() => ({
  lookup: undefined as unknown,
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
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({ catalog: null }),
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
    removalRoute = props.contextRemovalRoute;
    return null;
  },
}));

let removalRoute: ContextRemovalRoutePort | undefined;
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
  // draft row still names A at that path.
  await withRoute("manuscript/a.md?work=", "document-b", "/a.md", async (history) => {
    const before = history.length;
    await open(
      { documentId: "document-a", scheme: "manuscript", path: "/a.md", workId },
      {
        draftId: "draft-a",
        replaceIfSameDocument: true,
      },
    );
    expect(history.length).toBe(before + 1);
  });
});

it("repairs a renamed document's address in place and keeps its review", async () => {
  await withRoute(
    "manuscript/a.md?work=&draft=draft-a",
    "document-a",
    "/renamed.md",
    async (history) => {
      const before = history.length;
      const { request, options } = identityCommitRoute("document-a", {
        scheme: "manuscript",
        path: "/renamed.md",
        routeWorkId: workId,
      });
      await open(request, options);
      expect(history.length).toBe(before);
      expect(history.location.pathname).toContain("renamed.md");
      expect(history.location.search).toContain("draft=draft-a");
    },
  );
});

it("drops the review when the open command names another document", async () => {
  await withRoute("manuscript/a.md?work=&draft=draft-a", "document-a", "/a.md", async (history) => {
    await open({ documentId: "document-c", scheme: "manuscript", path: "/c.md", workId });
    expect(history.location.search).not.toContain("draft=");
  });
});

it("keeps the review when the removal coordinator relocates the address's document", async () => {
  // The coordinator replays a move of the document the address names; the review
  // stays until the owner, which knows identity, decides it no longer applies.
  await withRoute("manuscript/a.md?work=&draft=draft-a", "document-a", "/a.md", async (history) => {
    const before = history.length;
    removalRoute?.updateSearch(projectId, (search) => ({ ...search, path: "/moved.md" }));
    await vi.waitFor(() => expect(history.location.pathname).toContain("moved.md"));
    expect(history.length).toBe(before);
    expect(history.location.search).toContain("draft=draft-a");
  });
});

it("launches a review of the address's own document without moving the address to a stale path", async () => {
  // The draft list still names the document's old path.
  await withRoute("manuscript/renamed.md?work=", "document-a", "/renamed.md", async (history) => {
    const before = history.length;
    await open(
      { documentId: "document-a", scheme: "manuscript", path: "/old-name.md", workId },
      { draftId: "draft-a", replaceIfSameDocument: true },
    );
    expect(history.length).toBe(before);
    expect(history.location.pathname).toContain("renamed.md");
    expect(history.location.search).toContain("draft=draft-a");
  });
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

it("launches another document's review at its current path, not the path its draft row captured", async () => {
  // A was renamed to /renamed.md and B took /a.md, which the address now shows. The
  // launch still carries A's old path.
  await withRoute("manuscript/a.md?work=", "document-b", "/a.md", async (history) => {
    openDocumentA("/renamed.md");
    const before = history.length;
    await open(
      { documentId: "document-a", scheme: "manuscript", path: "/a.md", workId },
      { draftId: "draft-a", replaceIfSameDocument: true },
    );
    expect(history.length).toBe(before + 1);
    expect(history.location.pathname).toContain("/manuscript/renamed.md");
    expect(history.location.search).toContain("draft=draft-a");
  });
});

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

it("installs a cold review launch's tab at the route's own path spelling", async () => {
  // A deep link to a pending new-document draft: the address names the document, but no
  // tab exists yet. The address spells its path without a leading slash; the installed
  // tab must still match the route (`/path`), or nothing owns the route and a document
  // host rejects it.
  await withRoute("manuscript/new-draft.md?work=", "document-n", "/new-draft.md", async () => {
    useContextTabsStore.setState({ byProject: {} });
    await open(
      { documentId: "document-n", scheme: "manuscript", path: "/new-draft.md", workId },
      {
        draftId: "draft-n",
        replaceIfSameDocument: true,
        tab: {
          kind: "tracked",
          documentId: "document-n",
          scheme: "manuscript",
          path: "/new-draft.md",
          name: "new-draft.md",
          editable: true,
          filetype: "markdown",
          schemaType: "document",
          draftOnly: true,
          reviewWorkId: workId,
        },
      },
    );
    const { tabs } = getContextTabs(projectId);
    const route = { scheme: "manuscript" as const, path: "/new-draft.md", workId };
    expect(
      resolveWorkspaceRoute({ tabs, selectedDocumentId: undefined, locator: route }),
    ).toMatchObject({ kind: "owner" });
  });
});
