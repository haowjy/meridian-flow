// @vitest-environment jsdom
/** Phone rail uses route commands and shared failure chrome, without desktop document presentation. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ProjectDto } from "@meridian/contracts/projects";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, type ReactNode, useLayoutEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { type ContextTab, ThreadStoreProvider, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useDockDocumentStore } from "../dock/dock-document-store";
import { WorkspaceNavBody } from "../shell/WorkspaceNavBody";
import { useProjectLeaveGuard } from "./ProjectNavigationContext";
import type { ProjectRouteIssue } from "./ProjectRouteBoundary";
import type { RouteWorkResolution } from "./project-route";
import { ReadableProjectRoute } from "./ReadableProjectRoute";

const projectId = "00000000-0000-4000-8000-000000000020";
const workId = "00000000-0000-4000-8000-000000000021";
const state = vi.hoisted(() => ({
  history: null as unknown as ReturnType<typeof createMemoryHistory>,
  router: null as unknown,
  fail: false,
  guard: "run" as "run" | "cancel" | "supersede",
}));
vi.mock("@tanstack/react-router", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<typeof import("@tanstack/react-router")>()),
    useRouter: () => state.router,
    useRouterState: ({ select }: { select: (value: unknown) => unknown }) => {
      const location = useSyncExternalStore(
        (notify) => state.history.subscribe(notify),
        () => state.history.location,
      );
      return select({
        location: { ...location, search: { __meridianRawSearch: location.search } },
      });
    },
    useBlocker: () => {},
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  };
});
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined, isError: false, refetch: () => {} }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({
    status: "ready",
    works: [{ id: workId, name: "Work", isNoWork: false }],
    noWork: { id: "00000000-0000-4000-8000-000000000022", isNoWork: true },
    creations: new Map(),
    isFetching: false,
  }),
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [], isError: false }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => ({ catalog: null }),
}));
vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({ status: "ready", groups: [], refetch: () => {} }),
}));
vi.mock("@/features/account/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => true }));
vi.mock("../context/account-feature-context", async (original) => ({
  ...(await original<typeof import("../context/account-feature-context")>()),
  useAccountId: () => "account",
  useAccountResourceProjection: () => ({ records: [], folders: [] }),
  useContextRemovalCoordinator: () => ({
    getProjectSnapshot: () => ({ live: true }),
    admitDraftReview() {},
  }),
}));
vi.mock("../context/use-context-removal-project", () => ({
  useContextRemovalProject: () => ({ selection: { status: "none" } }),
}));
vi.mock("../context/open-project-document", () => ({
  ProjectDocumentNavigationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ProjectAddressDocument", () => ({ ProjectAddressDocument: () => null }));
vi.mock("../ProjectView", () => ({
  ProjectView: (props: Parameters<typeof PhoneHost>[0]) => <PhoneHost {...props} />,
}));
function PhoneHost({
  activeScreen,
  onSelectScreen,
  routeIssues,
  editorRouteWork,
  onDisplayedSelection,
}: {
  activeScreen: "work" | "context" | "chat";
  onSelectScreen: (screen: "work" | "context" | "chat") => void;
  routeIssues?: { editor?: ProjectRouteIssue; main?: ProjectRouteIssue };
  editorRouteWork: RouteWorkResolution;
  onDisplayedSelection: (selection: { editorWorkId: ParsedRequestId | null }) => void;
}) {
  useLayoutEffect(() => {
    onDisplayedSelection({
      editorWorkId: editorRouteWork.status === "present" ? editorRouteWork.workId : null,
    });
  }, [onDisplayedSelection, editorRouteWork]);
  useProjectLeaveGuard({
    dirty: () => state.guard !== "run",
    request: (intent) => {
      if (state.guard === "cancel") intent.cancel();
      else if (state.guard === "supersede") state.history.push(`/p/${projectId}/chats`);
      else intent.run();
    },
    cancel: () => {},
  });
  return (
    <>
      <WorkspaceNavBody
        activeScreen={activeScreen}
        onSelectScreen={onSelectScreen}
        presentation="phone"
      />
      {(routeIssues?.editor === "error" || routeIssues?.main === "error") && (
        <p role="alert">Destination failure</p>
      )}
    </>
  );
}
const tab = {
  kind: "tracked" as const,
  documentId: "chapter",
  tabInstanceId: "chapter-instance",
  workId,
  name: "chapter.md",
  scheme: "manuscript" as const,
  path: "/chapter.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} satisfies ContextTab;
beforeEach(() => {
  state.fail = false;
  state.guard = "run";
  i18n.load("en", {});
  i18n.activate("en");
});
async function phone(initial: string, run: () => Promise<void>) {
  state.history = createMemoryHistory({ initialEntries: [`/p/${projectId}${initial}`] });
  state.router = {
    history: state.history,
    navigate: async ({
      href,
      replace,
      state: next,
    }: {
      href: string;
      replace: boolean;
      state: object;
    }) => {
      if (state.fail) throw new Error("Offline");
      if (replace) state.history.replace(href, next);
      else state.history.push(href, next);
    },
  };
  const priorTabs = useContextTabsStore.getState();
  const priorDock = useDockDocumentStore.getState();
  useContextTabsStore.setState({
    byProject: { [projectId]: { tabs: [tab], selectedTabIdByWork: { [workId]: tab.documentId } } },
    _workspaceHydrated: true,
  });
  useDockDocumentStore.setState({
    occupant: { projectId, screen: "chat", tab, review: null },
    revision: 42,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await withReactRoot(
      <I18nProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <ThreadStoreProvider now={1}>
            <ReadableProjectRoute
              project={{ id: projectId } as ProjectDto}
              entryHydration={{ status: "disabled" }}
              user={{ userId: "account" }}
            />
          </ThreadStoreProvider>
        </QueryClientProvider>
      </I18nProvider>,
      run,
    );
    expect(useDockDocumentStore.getState().occupant).toEqual({
      projectId,
      screen: "chat",
      tab,
      review: null,
    });
    expect(useDockDocumentStore.getState().revision).toBe(42);
  } finally {
    client.clear();
    state.history.destroy();
    useContextTabsStore.setState(priorTabs);
    useDockDocumentStore.setState(priorDock);
  }
}
async function click(name: string) {
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent === name);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}
it.each([
  ["Work", `/works/${workId}?view=files`],
  ["Editor", `/editor?work=${workId}`],
])("phone reselecting %s leaves its entry and view untouched", async (name, initial) => {
  await phone(initial, async () => {
    const before = state.history.location;
    await click(name);
    expect(state.history.location).toBe(before);
  });
});
it("phone rail displays a pre-acceptance failure on its source, then retires it on success", async () => {
  await phone(`/works/${workId}?view=files`, async () => {
    state.fail = true;
    await click("Chat");
    expect(state.history.location.pathname).toContain(`/works/${workId}`);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("This view couldn’t open.");
    state.fail = false;
    await click("Chat");
    expect(state.history.location.pathname).toBe(`/p/${projectId}/chats`);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
it("phone rail reports a failed Editor commit on the accepted destination", async () => {
  await phone(`/editor?work=${workId}`, async () => {
    await click("Work");
    const select = vi.spyOn(useContextTabsStore.getState(), "selectTab").mockImplementation(() => {
      throw new Error("Install failed");
    });
    try {
      await click("Editor");
      expect(state.history.location.pathname).toBe(`/p/${projectId}/editor/manuscript/chapter.md`);
      expect(document.querySelector('[role="alert"]')?.textContent).toBe("Destination failure");
    } finally {
      select.mockRestore();
    }
  });
});
it.each(["cancel", "supersede"] as const)("phone %s is silent", async (guard) => {
  await phone(`/works/${workId}`, async () => {
    state.guard = guard;
    await click("Chat");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    if (guard === "cancel") expect(state.history.location.pathname).toContain(`/works/${workId}`);
    else expect(state.history.location.pathname).toBe(`/p/${projectId}/chats`);
  });
});
