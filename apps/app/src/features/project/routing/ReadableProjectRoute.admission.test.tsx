// @vitest-environment jsdom
/** The route reports what its address is waiting on: still loading, failed, or settled. */
import type { ProjectDto } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

const projectId = "00000000-0000-4000-8000-000000000030";
const workId = "00000000-0000-4000-8000-000000000031";
const state = vi.hoisted(() => ({
  history: null as unknown as ReturnType<typeof createMemoryHistory>,
  router: null as unknown,
  drafts: { status: "loading", groups: null, refetch: vi.fn() } as unknown,
  catalogRefetch: vi.fn(),
  lookupRefetch: vi.fn(),
  issue: undefined as ProjectRouteIssue | undefined,
  retry: undefined as (() => void) | undefined,
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => state.router,
  useRouterState: () => ({
    ...state.history.location,
    search: { __meridianRawSearch: state.history.location.search },
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
  useQuery: () => ({
    data: {
      kind: "current",
      document: { kind: "available", documentId: "document-new" },
    },
    isError: false,
    refetch: state.lookupRefetch,
  }),
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [], isError: false }),
}));
vi.mock("@/client/query/useContextCatalog", async (original) => ({
  ...(await original<typeof import("@/client/query/useContextCatalog")>()),
  // The live catalog settled without the document, as it does for any pending draft.
  useContextCatalogView: () => ({
    catalog: {
      normalized: { generation: "g", appliedRevision: "1", entries: new Map() },
      findPath: () => null,
      findDocument: () => null,
    },
    isComplete: true,
    isFetching: false,
    isError: false,
    refetch: state.catalogRefetch,
  }),
}));
vi.mock("@/client/query/useWorkDrafts", async (original) => ({
  ...(await original<typeof import("@/client/query/useWorkDrafts")>()),
  useWorkDrafts: () => state.drafts,
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
  ProjectView: (props: {
    routeIssues?: { editor?: ProjectRouteIssue };
    onRetryEditorRoute?: () => void;
  }) => {
    state.issue = props.routeIssues?.editor;
    state.retry = props.onRetryEditorRoute;
    return null;
  },
}));

async function coldOpen(drafts: unknown) {
  state.drafts = drafts;
  state.history = createMemoryHistory({
    initialEntries: [`/p/${projectId}/editor/manuscript/new-draft.md?work=&draft=draft-n`],
  });
  state.router = { history: state.history, navigate: async () => undefined };
  const prior = useContextTabsStore.getState();
  useContextTabsStore.setState({
    byProject: {},
    _reviewOverlayByProject: {},
    _workspaceHydrated: true,
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
      async () => undefined,
    );
  } finally {
    client.clear();
    useContextTabsStore.setState(prior);
  }
}

it("waits while the Work's drafts are still loading", async () => {
  await coldOpen({ status: "loading", groups: null, refetch: vi.fn() });
  expect(state.issue).toBe("loading");
});

it("ends the wait with a failure, keeping the address, when the Work's drafts failed to load", async () => {
  const refetch = vi.fn();
  state.catalogRefetch.mockClear();
  state.lookupRefetch.mockClear();
  await coldOpen({ status: "error", groups: [], refetch });
  expect(state.issue).toBe("error");
  expect(state.history.location.search).toContain("draft=draft-n");
  expect(state.history.location.pathname).toContain("new-draft.md");

  // Retry re-reads what failed, not the whole destination.
  state.retry?.();
  expect(refetch).toHaveBeenCalledOnce();
  expect(state.catalogRefetch).toHaveBeenCalledOnce();
  expect(state.lookupRefetch).toHaveBeenCalledOnce();
});
