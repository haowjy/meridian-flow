// @vitest-environment jsdom
/** Displayed-pane retention and real chat navigation meet at the production rail seam. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { type ContextTab, ThreadStoreProvider, useContextTabsStore } from "@/client/stores";
import { resolveEditorPresentation } from "../context/editor-presentation";
import type { VisibleEditorRoute } from "../context/resolve-visible-editor-tab";
import { useDockViewStore } from "../dock/dock-view-store";
import { captureRailDocumentHandOff } from "../dock/use-rail-document-hand-off";
import { useProjectSurfacePrefsStore } from "../layout/surface-prefs-store";
import type { ScreenKey } from "../shell/screens";
import { useProjectChatNavigation } from "./chat-navigation";
import { ProjectRouteBoundary, type ProjectRouteIssue } from "./ProjectRouteBoundary";
import { parseProjectAddress } from "./project-address";
import { createProjectNavigation } from "./project-navigation";
import { switchScreen } from "./switch-screen";

const projectId = "550e8400-e29b-41d4-a716-446655440000";
const A: ContextTab = {
  kind: "tracked",
  documentId: "A",
  name: "A.md",
  scheme: "manuscript",
  path: "/A.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};
const B: ContextTab = { ...A, documentId: "B", name: "B.md", path: "/B.md" };
type EditorRoute = VisibleEditorRoute & { editorWorkId: string };
const editorA: EditorRoute = {
  editorWorkId: "work",
  activeContextScheme: "manuscript",
  activeContextPath: "/A.md",
};
const editorB: EditorRoute = { ...editorA, activeContextPath: "/B.md" };

beforeEach(() => {
  useDockViewStore.setState(useDockViewStore.getInitialState(), true);
  useProjectSurfacePrefsStore.setState(useProjectSurfacePrefsStore.getInitialState(), true);
  useContextTabsStore.setState(useContextTabsStore.getInitialState(), true);
  useContextTabsStore.setState({
    byProject: { [projectId]: { tabs: [A, B], selectedTabIdByWork: { work: "B" } } },
  });
  localStorage.clear();
});

async function setup(source: ScreenKey = "context") {
  const sourceHref =
    source === "work"
      ? `/p/${projectId}/works/700db898-57fb-4ffa-8366-46ad6a3880be`
      : `/p/${projectId}/editor/manuscript/A.md`;
  const parsed = parseProjectAddress(sourceHref);
  if (parsed.kind !== "valid") throw new Error("Bad fixture address");
  const address = parsed.address;
  const history = createMemoryHistory({
    initialEntries: [sourceHref],
  });
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
      navigate: async (href, { state }) => {
        history.push(href, state);
      },
    },
    () => ({ work: { kind: "none" } }),
  );
  const accepted = vi.fn();
  const reveal = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  let pending: Promise<unknown> | undefined;
  function Pane({ current, issue }: { current: EditorRoute; issue?: ProjectRouteIssue }) {
    const prior = useRef<EditorRoute | null>(null);
    const presentation = resolveEditorPresentation({
      current,
      prior: prior.current,
      requestedWorkId: current.editorWorkId,
      screen: source,
      contextLive: true,
      issue,
    });
    useLayoutEffect(() => {
      if (presentation.active) prior.current = current;
    });
    const chat = useProjectChatNavigation({
      accountId: "writer",
      projectId,
      activeScreen: source,
      urlChatId: null,
      go: (destination, options, onAccepted) =>
        navigation.navigate({ ...address, destination }, options, onAccepted),
    });
    return (
      <>
        <ProjectRouteBoundary issue={issue} retainWhileLoading={presentation.retainWhileLoading}>
          <p data-pane="editor">{presentation.mounted?.activeContextPath}</p>
        </ProjectRouteBoundary>
        <button
          type="button"
          onClick={() => {
            pending = switchScreen(
              "chat",
              {
                source,
                capture: (destination) =>
                  captureRailDocumentHandOff({
                    projectId,
                    source,
                    destination,
                    phone: false,
                    editor: presentation.visible ? presentation.mounted : null,
                    selection: { status: "none", revision: 0 },
                    records: [],
                    folders: [],
                    revealDock: reveal,
                  }),
                showChatScreen: chat.showChatScreen,
                openInEditor: async () => {
                  throw new Error("Wrong destination");
                },
                otherwise: async () => {
                  throw new Error("Wrong owner");
                },
              },
              accepted,
            );
          }}
        >
          Chat
        </button>
      </>
    );
  }
  const render = async (current: EditorRoute, issue?: ProjectRouteIssue) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ThreadStoreProvider now={0}>
            <Pane current={current} issue={issue} />
          </ThreadStoreProvider>
        </QueryClientProvider>,
      ),
    );
  };
  await render(editorA);
  return {
    container,
    render,
    accepted,
    reveal,
    history,
    click: async () => {
      await act(async () => {
        container.querySelector("button")?.click();
        await pending;
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      navigation.dispose();
      client.clear();
    },
  };
}

it.each([
  true,
  false,
])("pending admission carries the retained rendered pane, not B (B cached: %s)", async (cached) => {
  if (!cached)
    useContextTabsStore.setState({
      byProject: { [projectId]: { tabs: [A], selectedTabIdByWork: { work: "A" } } },
    });
  const rig = await setup();
  await rig.render(editorB, "loading");
  expect(rig.container.querySelector('[data-pane="editor"]')?.textContent).toBe("/A.md");
  expect(rig.container.querySelector("[inert]")).toBeNull();
  await rig.click();
  expect(useDockViewStore.getState().occupant?.tab.documentId).toBe("A");
  expect(rig.history.location.pathname).toBe(`/p/${projectId}/chats`);
  expect(rig.accepted).toHaveBeenCalledOnce();
  await rig.cleanup();
});

it.each([
  "error",
  "unavailable",
] as const)("a pane hidden by %s carries nothing, even with a cached B tab", async (issue) => {
  const rig = await setup();
  await rig.render(editorB, issue);
  expect(rig.container.querySelector("[inert]")).not.toBeNull();
  await rig.click();
  expect(useDockViewStore.getState().occupant).toBeNull();
  expect(rig.reveal).not.toHaveBeenCalled();
  await rig.cleanup();
});

it.each([
  "context",
  "work",
] as const)("%s to Chat executes the real showChatScreen accepted callback", async (source) => {
  const rig = await setup(source);
  if (source === "work")
    useDockViewStore.setState({ occupant: { projectId, screen: "work", tab: A } });
  await rig.click();
  expect(useDockViewStore.getState().occupant).toMatchObject({ projectId, screen: "chat", tab: A });
  expect(rig.accepted).toHaveBeenCalledOnce();
  expect(rig.reveal).toHaveBeenCalledWith("document");
  expect(rig.history.location.pathname).toBe(`/p/${projectId}/chats`);
  await rig.cleanup();
});
