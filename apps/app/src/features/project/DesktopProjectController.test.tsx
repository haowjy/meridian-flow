// @vitest-environment jsdom
/** The production desktop controller drives real history and document slots; hosts alone are lightweight. */
import "fake-indexeddb/auto";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ResourceRecord } from "@meridian/resource-replica";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type ContextTab, ThreadStoreProvider, useContextTabsStore } from "@/client/stores";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IndexedDbResourceMetadata } from "@/core/resources/indexeddb-resource-metadata";
import {
  AccountFeatureTestProvider,
  useContextRemovalCoordinator,
} from "@/test-support/account-feature-provider";
import {
  DesktopProjectPresentationProvider,
  useDesktopProjectController,
} from "./DesktopProjectController";
import { DockOpenInEditor } from "./dock/DockDocumentButtons";
import { useDockViewStore } from "./dock/dock-view-store";
import { useProjectSurfacePrefsStore } from "./layout/surface-prefs-store";
import { ChatNavigationProvider, useProjectChatNavigation } from "./routing/chat-navigation";
import {
  DocumentSwitchFailureProvider,
  destinationFailure,
  headerFailure,
  useDocumentSwitchFailures,
} from "./routing/document-switch-failure";
import { createEditorDocumentCommand } from "./routing/editor-document-command";
import {
  type OpenContextRoute,
  ProjectNavigationProvider,
} from "./routing/ProjectNavigationContext";
import { ProjectRouteBoundary, type ProjectRouteIssue } from "./routing/ProjectRouteBoundary";
import { parseProjectAddress } from "./routing/project-address";
import { createProjectNavigation, type ProjectLeaveGuard } from "./routing/project-navigation";
import type { ScreenKey } from "./shell/screens";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const projectId = "550e8400-e29b-41d4-a716-446655440000";
const workId = "700db898-57fb-4ffa-8366-46ad6a3880be";
const A = {
  kind: "tracked",
  documentId: "A",
  tabInstanceId: "A-instance",
  workId,
  name: "A.md",
  scheme: "manuscript",
  path: "/A.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} satisfies ContextTab;
const B = { ...A, documentId: "B", tabInstanceId: "B-instance", name: "B.md", path: "/B.md" };
const address = (path: string) => {
  const parsed = parseProjectAddress(`/p/${projectId}${path}`);
  if (parsed.kind !== "valid") throw new Error("Invalid fixture address");
  return parsed.address;
};
let accountId: string;
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => {
  accountId = crypto.randomUUID();
  i18n.load("en", {});
  i18n.activate("en");
  localStorage.clear();
  useContextTabsStore.setState(useContextTabsStore.getInitialState(), true);
  useContextTabsStore.setState({
    _workspaceHydrated: true,
    byProject: { [projectId]: { tabs: [A, B], selectedTabIdByWork: { [workId]: "A" } } },
  });
  useDockViewStore.setState(useDockViewStore.getInitialState(), true);
  useProjectSurfacePrefsStore.setState(useProjectSurfacePrefsStore.getInitialState(), true);
});
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});
async function setup(source: ScreenKey = "context") {
  const history = createMemoryHistory({
    initialEntries: [
      `/p/${projectId}${source === "context" ? "/editor/manuscript/A.md" : source === "work" ? `/works/${workId}` : "/chats"}`,
    ],
  });
  let rejectNavigation = false;
  const navigation = createProjectNavigation(
    {
      read: () => ({
        href: history.location.href,
        key: history.location.state.__TSR_key ?? "",
        state: { ...history.location.state },
      }),
      subscribe: (listener) => history.subscribe(listener),
      flush: () => history.flush(),
      settlePendingTraversal: () => undefined,
      replaceEntry: (href, state) => history.replace(href, state),
      navigate: async (href, options) => {
        if (rejectNavigation) throw new Error("Dispatch failed");
        if (options.replace) history.replace(href, options.state);
        else history.push(href, options.state);
      },
    },
    () => ({ work: { kind: "none" } }),
  );
  let open!: OpenContextRoute;
  let issue: ProjectRouteIssue | undefined;
  let path = "/A.md";
  let contextLive = true;
  let recovery = false;
  let chooser = false;
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Controller() {
    const failures = useDocumentSwitchFailures();
    const revision = useDockViewStore((state) => state.revision);
    const entry = useSyncExternalStore(
      (listener) => history.subscribe(listener),
      () => history.location,
    );
    const screen: ScreenKey = entry.pathname.includes("/editor")
      ? "context"
      : entry.pathname.includes("/works")
        ? "work"
        : "chat";
    const acceptedFailure = destinationFailure(
      failures.failures,
      entry.href,
      entry.state.__TSR_key ?? "",
    );
    const switcher = useDesktopProjectController({
      projectId,
      screen,
      entryKey: entry.state.__TSR_key ?? "",
      current: recovery
        ? null
        : {
            editorWorkId: workId,
            activeContextScheme: chooser ? null : "manuscript",
            activeContextPath: chooser ? null : path,
          },
      requestedWorkId: workId,
      contextLive,
      issue: acceptedFailure ? "error" : issue,
    });
    return (
      <DesktopProjectPresentationProvider screen={screen} {...switcher}>
        <button type="button" onClick={() => switcher.selectScreen("chat")}>
          Chat
        </button>
        <button type="button" onClick={() => switcher.selectScreen("context")}>
          Editor
        </button>
        <button type="button" onClick={() => switcher.selectScreen("work")}>
          Work
        </button>
        {switcher.railSwitchFailed && <p role="alert">Rail failure</p>}
        {headerFailure(failures.failures, revision) && <p>Header failure</p>}
        {switcher.dockDocument && (
          <DockOpenInEditor projectId={projectId} document={switcher.dockDocument} />
        )}
        <ProjectRouteBoundary
          issue={acceptedFailure ? "error" : issue}
          retainWhileLoading={switcher.editorPresentation.retainWhileLoading}
          onRetry={() => failures.clear()}
        >
          <p data-editor>{switcher.editorPresentation.resolved.tab?.name ?? "Chooser"}</p>
        </ProjectRouteBoundary>
        <p data-dock>{switcher.dockDocument?.tab.name}</p>
      </DesktopProjectPresentationProvider>
    );
  }
  function Route() {
    const removal = useContextRemovalCoordinator();
    open = createEditorDocumentCommand({
      projectId,
      accountId,
      read: () => ({
        navigation,
        address: address(history.location.pathname.split(projectId)[1]),
        editorWorkId: workId,
        noWorkId: null,
        manuscriptCatalog: null,
      }),
      lookup: async () => ({ kind: "failed" }),
      admitDraftReview: (tab) => removal.admitDraftReview(projectId, tab),
    });
    const entry = useSyncExternalStore(
      (listener) => history.subscribe(listener),
      () => history.location,
    );
    const chat = useProjectChatNavigation({
      accountId: "writer",
      projectId,
      activeScreen: source,
      urlChatId: null,
      go: (destination, options) =>
        navigation.navigate({ ...address("/chats"), destination }, options),
    });
    return (
      <DocumentSwitchFailureProvider entryKey={entry.state.__TSR_key ?? ""}>
        <ProjectNavigationProvider
          openContextRoute={open}
          isCurrentNavigation={navigation.isCurrent}
          screenCommands={{
            showEditor: () => navigation.navigate(address("/editor"), { replace: false }),
            showWork: () => navigation.navigate(address(`/works/${workId}`), { replace: false }),
          }}
        >
          <ChatNavigationProvider value={chat}>
            <Controller />
          </ChatNavigationProvider>
        </ProjectNavigationProvider>
      </DocumentSwitchFailureProvider>
    );
  }
  const render = async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadStoreProvider now={0}>
            <I18nProvider i18n={i18n}>
              <TooltipProvider>
                <AccountFeatureTestProvider accountId={accountId}>
                  <Route />
                </AccountFeatureTestProvider>
              </TooltipProvider>
            </I18nProvider>
          </ThreadStoreProvider>
        </QueryClientProvider>,
      ),
    );
  };
  await render();
  dispose = async () => {
    await act(async () => root.unmount());
    navigation.dispose();
    client.clear();
  };
  const click = async (label: string) =>
    act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          label === "Header"
            ? 'button[aria-label="Open in Editor"]'
            : label === "Chat"
              ? "button:nth-of-type(1)"
              : "button:nth-of-type(2)",
        )
        ?.click(),
    );
  return {
    history,
    navigation,
    container,
    click,
    open,
    pending: async (nextIssue: ProjectRouteIssue) => {
      path = "/B.md";
      issue = nextIssue;
      contextLive = false;
      await render();
    },
    recover: async () => {
      recovery = true;
      await render();
    },
    chooser: async () => {
      chooser = true;
      await render();
    },
    failNavigation: () => {
      rejectNavigation = true;
    },
    replace: async (tab: ContextTab) =>
      act(async () => {
        const store = useDockViewStore.getState();
        store.commit(store.claim(), {
          projectId,
          screen: source === "work" ? "work" : "chat",
          tab,
        });
      }),
  };
}
it.each([true, false])("retained A, not pending B (cached: %s), moves to Chat", async (cached) => {
  const rig = await setup();
  if (!cached)
    await act(async () =>
      useContextTabsStore.setState((state) => ({
        byProject: {
          ...state.byProject,
          [projectId]: { ...state.byProject[projectId], tabs: [A] },
        },
      })),
    );
  await rig.pending("loading");
  await rig.click("Chat");
  expect(rig.history.location.pathname).toContain("/chats");
  expect(useDockViewStore.getState().occupant?.tab.documentId).toBe("A");
});
it.each(["error", "unavailable"] as const)("hidden %s pane carries nothing", async (issue) => {
  const rig = await setup();
  await rig.pending(issue);
  await rig.click("Chat");
  expect(useDockViewStore.getState().occupant).toBeNull();
});
it.each([
  "chat",
  "work",
] as const)("%s document opens as a real Editor tab before dock consumption", async (source) => {
  const rig = await setup(source);
  await rig.replace(B);
  await rig.click("Editor");
  expect(rig.history.location.pathname).toContain("/editor/manuscript/B.md");
  expect(useContextTabsStore.getState().byProject[projectId].selectedTabIdByWork[workId]).toBe("B");
  expect(useDockViewStore.getState().occupant).toBeNull();
});
it("Work Files can follow the rail to Chat", async () => {
  const rig = await setup("work");
  await rig.replace(B);
  await rig.click("Chat");
  expect(useDockViewStore.getState().occupant).toMatchObject({
    screen: "chat",
    tab: { documentId: "B" },
  });
});
it("collapsed occupant carries nothing", async () => {
  const rig = await setup("chat");
  await rig.replace(B);
  await act(async () =>
    useProjectSurfacePrefsStore.setState((state) => ({
      slotPrefs: { ...state.slotPrefs, dock: { ...state.slotPrefs.dock, collapsed: true } },
    })),
  );
  await rig.click("Editor");
  expect(rig.history.location.pathname).toBe(`/p/${projectId}/editor`);
  expect(useDockViewStore.getState().occupant?.tab.documentId).toBe("B");
});
it("cancel and supersede leave the document and show no failure", async () => {
  const rig = await setup("chat");
  await rig.replace(B);
  rig.navigation.registerGuard({
    request: (intent) => intent.cancel(),
    dirty: () => true,
    cancel: () => undefined,
  });
  await rig.click("Editor");
  expect(rig.history.location.pathname).toContain("/chats");
  expect(useDockViewStore.getState().occupant?.tab.documentId).toBe("B");
  expect(rig.container.querySelector('[role="alert"]')).toBeNull();
  let intent: Parameters<ProjectLeaveGuard["request"]>[0] | undefined;
  rig.navigation.registerGuard({
    request: (next) => {
      intent = next;
    },
    dirty: () => true,
    cancel: () => undefined,
  });
  await rig.click("Editor");
  await act(async () => {
    rig.navigation.beginIntent();
    intent?.run();
  });
  expect(useDockViewStore.getState().occupant?.tab.documentId).toBe("B");
  expect(rig.container.querySelector('[role="alert"]')).toBeNull();
});
it("failed admission stays on Editor, keeps the dock, and Retry clears its failure", async () => {
  const rig = await setup("chat");
  await rig.replace(B);
  const original = useContextTabsStore.getState().openTab;
  useContextTabsStore.setState({ openTab: () => ({ kind: "ineligible" }) });
  try {
    await rig.click("Editor");
  } finally {
    useContextTabsStore.setState({ openTab: original });
  }
  expect(rig.history.location.pathname).toContain("/editor/manuscript/B.md");
  expect(useDockViewStore.getState().occupant?.tab.documentId).toBe("B");
  expect(rig.container.textContent).toContain("This destination couldn’t load.");
  await act(async () =>
    Array.from(rig.container.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry")
      ?.click(),
  );
  expect(rig.container.textContent).not.toContain("This destination couldn’t load.");
});
it("newer dock intent wins without blocking successful tab installation", async () => {
  const rig = await setup("chat");
  await rig.replace(B);
  rig.navigation.registerGuard({
    request: (intent) => {
      const store = useDockViewStore.getState();
      store.commit(store.claim(), { projectId, screen: "chat", tab: A });
      intent.run();
    },
    dirty: () => true,
    cancel: () => undefined,
  });
  await rig.click("Editor");
  expect(useDockViewStore.getState().occupant?.tab.documentId).toBe("A");
  expect(useContextTabsStore.getState().byProject[projectId].selectedTabIdByWork[workId]).toBe("B");
});
it("source rail feedback expires on same-screen navigation, and ordinary opens do not opt in", async () => {
  const rig = await setup("work");
  rig.failNavigation();
  await rig.click("Editor");
  expect(rig.container.textContent).toContain("Rail failure");
  expect(rig.container.textContent).not.toContain("This destination couldn’t load.");
  await act(async () => rig.history.push(`/p/${projectId}/works`));
  expect(rig.container.textContent).not.toContain("Rail failure");
  const result = await rig.open({ scheme: "unfiled", path: "", documentId: "missing-local" });
  expect(result).toMatchObject({ kind: "failed", stage: "before-acceptance" });
  expect(rig.container.textContent).not.toContain("Rail failure");
});
it("header feedback expires permanently when A is replaced by B then A", async () => {
  const rig = await setup("chat");
  await rig.replace(A);
  rig.failNavigation();
  await rig.click("Header");
  expect(rig.container.textContent).toContain("This view couldn’t open.");
  await rig.replace(B);
  await rig.replace(A);
  expect(rig.container.textContent).not.toContain("This view couldn’t open.");
});

async function seedProjection(
  lifecycle: ResourceRecord["resource"]["lifecycle"],
  canonical: ResourceRecord["resource"]["canonical"],
) {
  const metadata = new IndexedDbResourceMetadata(accountId, () => undefined);
  const record: ResourceRecord = {
    resource: {
      handle: "resource-A",
      revision: 1,
      identity: { documentId: "A", revision: 1 },
      content: { kind: "unacquired" },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical,
      lifecycle,
      aliases: {},
      obligations: {},
    },
    intents: [],
  };
  expect(
    await metadata.commitCatalog({
      expectedRevision: null,
      next: {
        projectId,
        scope: { kind: "work", projectId, workId },
        revision: 1,
        generation: "seed",
        appliedRevision: "1",
        observedHeadRevision: "1",
        cursor: "seed",
        entries: [
          {
            kind: "file",
            entryId: "A",
            scope: { kind: "work", projectId, workId },
            sourceId: "manuscript",
            parentId: "manuscript",
            name: "A.md",
            aliases: [],
            path: ["A.md"],
            uri: "manuscript://@/A.md",
            provisionalName: false,
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
      },
      resources: [{ expectedRevision: null, next: record }],
      folders: [],
    }),
  ).toBe("committed");
  await metadata.finishClose();
}
it.each([
  "context",
  "chat",
] as const)("%s carries the actual resource projection after a rename", async (source) => {
  await seedProjection(
    { kind: "acknowledged", availabilityGeneration: null },
    { scheme: "manuscript", path: "/renamed.md", name: "renamed.md", workId, workSlug: null },
  );
  const rig = await setup(source);
  if (source === "chat") await rig.replace(A);
  await expect
    .poll(async () => {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      return rig.container.textContent;
    })
    .toContain("renamed.md");
  await rig.click(source === "context" ? "Chat" : "Editor");
  if (source === "context")
    expect(useDockViewStore.getState().occupant?.tab.name).toBe("renamed.md");
  else expect(rig.history.location.pathname).toContain("/editor/manuscript/renamed.md");
});
it.each(["removed", "terminal"] as const)("a %s projection carries nothing", async (lifecycle) => {
  await seedProjection(
    lifecycle === "terminal"
      ? { kind: "terminal", generation: "gone", transitionId: "delete-A" }
      : { kind: "acknowledged", availabilityGeneration: null },
    null,
  );
  const rig = await setup();
  await expect
    .poll(async () => {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      return rig.container.querySelector("[data-editor]")?.textContent;
    })
    .toBe("Chooser");
  await rig.click("Chat");
  expect(useDockViewStore.getState().occupant).toBeNull();
});
it.each(["recover", "chooser"] as const)("%s presentation carries nothing", async (mode) => {
  const rig = await setup();
  await rig[mode]();
  await rig.click("Chat");
  expect(useDockViewStore.getState().occupant).toBeNull();
});
it("another project's parked occupant carries nothing", async () => {
  const rig = await setup("chat");
  await act(async () => {
    const store = useDockViewStore.getState();
    store.commit(store.claim(), { projectId: "another", screen: "chat", tab: B });
  });
  await rig.click("Editor");
  expect(rig.history.location.pathname).toBe(`/p/${projectId}/editor`);
  expect(useDockViewStore.getState().occupant?.projectId).toBe("another");
});

it("Work receives no document and leaves a parked Chat occupant alone", async () => {
  const rig = await setup();
  await rig.replace(B);
  await act(async () =>
    Array.from(rig.container.querySelectorAll("button"))
      .find((button) => button.textContent === "Work")
      ?.click(),
  );
  expect(rig.history.location.pathname).toContain(`/works/${workId}`);
  expect(useDockViewStore.getState().occupant).toMatchObject({
    screen: "chat",
    tab: { documentId: "B" },
  });
});
