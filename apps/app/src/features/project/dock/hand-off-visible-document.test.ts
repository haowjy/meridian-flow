/** Rail hand-off contract at the real dock and surface-preference store boundary. */
import type { ResourceRecord } from "@meridian/resource-replica";
import { createMemoryHistory } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { useProjectSurfacePrefsStore } from "../layout/surface-prefs-store";
import { parseProjectAddress } from "../routing/project-address";
import { createProjectNavigation, type ProjectLeaveGuard } from "../routing/project-navigation";
import { type DockDocument, useDockViewStore } from "./dock-view-store";
import { handOffVisibleDocument } from "./hand-off-visible-document";

const editorTab: ContextTab = {
  kind: "tracked",
  documentId: "chapter",
  scheme: "manuscript",
  path: "/chapter.md",
  name: "chapter.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};
const panelTab: ContextTab = {
  ...editorTab,
  documentId: "peek",
  path: "/peek.md",
  name: "peek.md",
};
const chatDocument: DockDocument = { projectId: "project", screen: "chat", tab: panelTab };

beforeEach(() => {
  useDockViewStore.setState(useDockViewStore.getInitialState(), true);
  useProjectSurfacePrefsStore.setState(useProjectSurfacePrefsStore.getInitialState(), true);
});

function handOff(overrides: Partial<Parameters<typeof handOffVisibleDocument>[0]> = {}) {
  const openInEditor = vi.fn();
  const revealDock = vi.fn();
  const plan = handOffVisibleDocument({
    projectId: "project",
    source: "context",
    destination: "chat",
    phone: false,
    editorTab,
    records: [],
    folders: [],
    revealDock,
    ...overrides,
  });
  plan?.commit();
  if (plan && overrides.destination === "context") openInEditor(plan.tab);
  return { openInEditor, revealDock };
}

function record(canonical: ResourceRecord["resource"]["canonical"]): ResourceRecord {
  return {
    resource: {
      handle: "resource",
      revision: 1,
      identity: { documentId: "chapter", revision: 1 },
      content: { kind: "unacquired" },
      classification: {
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
      canonical,
      lifecycle: { kind: "acknowledged", availabilityGeneration: null },
      aliases: {},
      obligations: {},
    },
    intents: [],
  };
}

describe("handOffVisibleDocument", () => {
  it("does nothing on a phone", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    const { openInEditor, revealDock } = handOff({ phone: true });
    expect(useDockViewStore.getState()).toMatchObject({ occupant: chatDocument, revision: 0 });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(revealDock).not.toHaveBeenCalled();
  });
  it("does nothing on the same screen", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    const { openInEditor, revealDock } = handOff({ source: "chat" });
    expect(useDockViewStore.getState()).toMatchObject({ occupant: chatDocument, revision: 0 });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(revealDock).not.toHaveBeenCalled();
  });
  it("Editor to Chat replaces the panel, reveals it and supersedes an older open", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    const oldClaim = useDockViewStore.getState().claim();
    const { revealDock, openInEditor } = handOff();
    expect(useDockViewStore.getState().occupant).toEqual({
      projectId: "project",
      screen: "chat",
      tab: editorTab,
    });
    expect(revealDock).toHaveBeenCalledWith("document");
    expect(openInEditor).not.toHaveBeenCalled();
    expect(useDockViewStore.getState().commit(oldClaim, chatDocument)).toBe(false);
  });
  it("Chat to Editor closes the panel and opens the occupant, not the old Editor tab", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    const { openInEditor, revealDock } = handOff({ source: "chat", destination: "context" });
    expect(useDockViewStore.getState().occupant).toBeNull();
    expect(openInEditor).toHaveBeenCalledWith(panelTab);
    expect(revealDock).not.toHaveBeenCalled();
  });
  it("carries nothing from a collapsed dock", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    useProjectSurfacePrefsStore.setState({ slotPrefs: { dock: { width: 360, collapsed: true } } });
    const { openInEditor } = handOff({ source: "chat", destination: "context" });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(useDockViewStore.getState().occupant).toEqual(chatDocument);
  });
  it("carries nothing from another project's occupant", () => {
    useDockViewStore.setState({ occupant: { ...chatDocument, projectId: "other" } });
    const { openInEditor } = handOff({ source: "chat", destination: "context" });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(useDockViewStore.getState().revision).toBe(0);
  });
  it("carries nothing from an occupant parked on another screen", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    const { openInEditor } = handOff({ source: "work", destination: "context" });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(useDockViewStore.getState().occupant).toEqual(chatDocument);
  });
  it("Work receives no document", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    const { openInEditor, revealDock } = handOff({ source: "chat", destination: "work" });
    expect(useDockViewStore.getState()).toMatchObject({ occupant: chatDocument, revision: 0 });
    expect(openInEditor).not.toHaveBeenCalled();
    expect(revealDock).not.toHaveBeenCalled();
  });
  it("carries nothing when the Editor shows no document", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    const { revealDock } = handOff({ editorTab: null });
    expect(revealDock).not.toHaveBeenCalled();
    expect(useDockViewStore.getState().occupant).toEqual(chatDocument);
  });
  it.each(["removed", "terminal"] as const)("carries nothing from a %s projection", (kind) => {
    const resource = record(null);
    if (kind === "terminal")
      resource.resource.lifecycle = {
        kind: "terminal",
        generation: "generation",
        transitionId: "delete",
      };
    const { revealDock, openInEditor } = handOff({ records: [resource] });
    expect(useDockViewStore.getState()).toMatchObject({ occupant: null, revision: 0 });
    expect(revealDock).not.toHaveBeenCalled();
    expect(openInEditor).not.toHaveBeenCalled();
  });
  it("carries the projected renamed tab, not its captured path", () => {
    const { revealDock } = handOff({
      records: [
        record({ scheme: "manuscript", path: "/renamed.md", name: "renamed.md", workId: null }),
      ],
    });
    expect(useDockViewStore.getState().occupant?.tab).toMatchObject({
      documentId: "chapter",
      path: "/renamed.md",
      name: "renamed.md",
    });
    expect(revealDock).toHaveBeenCalledWith("document");
  });
  it.each(["chat", "context"] as const)("carries a Work Files document to %s", (destination) => {
    const document: DockDocument = {
      ...chatDocument,
      screen: "work",
      tab: { ...panelTab, scheme: "scratch", workId: "work" },
    };
    useDockViewStore.setState({ occupant: document });
    const { revealDock, openInEditor } = handOff({ source: "work", destination });
    if (destination === "chat") {
      expect(useDockViewStore.getState().occupant).toEqual({ ...document, screen: "chat" });
      expect(revealDock).toHaveBeenCalledWith("document");
    } else {
      expect(useDockViewStore.getState().occupant).toBeNull();
      expect(openInEditor).toHaveBeenCalledWith(document.tab);
    }
  });
});

describe("syncOccupantScope", () => {
  it("parks a Chat occupant across screen changes", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    for (const screen of ["chat", "work", "context", "chat"] as const) {
      useDockViewStore.getState().syncOccupantScope("project", screen, "work");
      expect(useDockViewStore.getState().occupant).toEqual(chatDocument);
    }
  });
  it.each([
    "work",
    "context",
    "chat",
  ] as const)("drops a Work occupant leaving its Work or screen for %s", (screen) => {
    useDockViewStore.setState({
      occupant: {
        ...chatDocument,
        screen: "work",
        tab: { ...panelTab, scheme: "scratch", workId: "work" },
      },
    });
    useDockViewStore.getState().syncOccupantScope("project", "work", "work");
    expect(useDockViewStore.getState().occupant).not.toBeNull();
    useDockViewStore
      .getState()
      .syncOccupantScope("project", screen, screen === "work" ? "other" : "work");
    expect(useDockViewStore.getState().occupant).toBeNull();
  });
  it.each(["chat", "work"] as const)("drops a %s occupant on project change", (screen) => {
    useDockViewStore.setState({ occupant: { ...chatDocument, screen } });
    useDockViewStore.getState().syncOccupantScope("other", screen, "work");
    expect(useDockViewStore.getState().occupant).toBeNull();
  });
});

describe("accepted rail hand-off", () => {
  function setup(fail = false) {
    useDockViewStore.setState({ occupant: chatDocument });
    const plan = handOffVisibleDocument({
      projectId: "project",
      source: "chat",
      destination: "context",
      phone: false,
      editorTab,
      records: [],
      folders: [],
      revealDock: vi.fn(),
    });
    if (!plan) throw new Error("Expected a visible document");
    const history = createMemoryHistory({
      initialEntries: ["/p/550e8400-e29b-41d4-a716-446655440000/chats"],
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
          if (fail) throw new Error("Navigation failed");
          history.push(href, state);
        },
      },
      () => ({ work: { kind: "none" } }),
    );
    const parsed = parseProjectAddress("/p/550e8400-e29b-41d4-a716-446655440000/editor");
    if (parsed.kind !== "valid") throw new Error("Expected address");
    const openInEditor = vi.fn();
    const switchView = () =>
      navigation.transition(
        parsed.address,
        { replace: false },
        {
          isCurrent: () => true,
          commit: () => {
            openInEditor(plan.tab);
            plan.commit();
          },
        },
      );
    return { navigation, switchView, openInEditor };
  }
  it("does not change the dock or open a tab when the leave decision cancels", async () => {
    const { navigation, switchView, openInEditor } = setup();
    navigation.registerGuard({
      request: (intent) => intent.cancel(),
      dirty: () => true,
      cancel: vi.fn(),
    });
    await expect(switchView()).resolves.toEqual({ kind: "cancelled" });
    expect(useDockViewStore.getState().occupant).toEqual(chatDocument);
    expect(openInEditor).not.toHaveBeenCalled();
    navigation.dispose();
  });
  it("does not change the dock or open a tab when navigation fails", async () => {
    const { navigation, switchView, openInEditor } = setup(true);
    expect((await switchView()).kind).toBe("failed");
    expect(useDockViewStore.getState().occupant).toEqual(chatDocument);
    expect(openInEditor).not.toHaveBeenCalled();
    navigation.dispose();
  });
  it("does not commit a superseded rail intent", async () => {
    const { navigation, switchView, openInEditor } = setup();
    let decision: Parameters<ProjectLeaveGuard["request"]>[0] | undefined;
    navigation.registerGuard({
      request: (intent) => {
        decision = intent;
      },
      dirty: () => true,
      cancel: vi.fn(),
    });
    const first = switchView();
    navigation.beginIntent();
    decision?.run();
    await expect(first).resolves.toEqual({ kind: "superseded" });
    expect(useDockViewStore.getState().occupant).toEqual(chatDocument);
    expect(openInEditor).not.toHaveBeenCalled();
    navigation.dispose();
  });
  it("a newer dock pick wins while an accepted rail intent is pending", async () => {
    const { navigation, switchView } = setup();
    navigation.registerGuard({
      request: (intent) => {
        const store = useDockViewStore.getState();
        store.commit(store.claim(), { ...chatDocument, tab: editorTab });
        intent.run();
      },
      dirty: () => true,
      cancel: vi.fn(),
    });
    await expect(switchView()).resolves.toEqual({ kind: "applied" });
    expect(useDockViewStore.getState().occupant?.tab).toEqual(editorTab);
    navigation.dispose();
  });
});
