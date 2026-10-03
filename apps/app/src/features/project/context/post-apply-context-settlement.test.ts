import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { AccountPostApplyDispositionOwner } from "../draft-apply-recovery/draft-apply-recovery-owner";
import type { ProjectSearch } from "../routing/project-route";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";

const identity = {
  accountId: "account-a",
  projectId: "project-a",
  workId: "work-a",
  documentId: "document-a",
  draftId: "draft-a",
};

function draftTab(token = "tab-a") {
  return {
    kind: "tracked" as const,
    documentId: "document-a",
    scheme: "manuscript" as const,
    path: "/chapter.md",
    name: "chapter.md",
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
    draftOnly: true,
    reviewWorkId: "work-a",
    reviewDraftId: "draft-a",
    tabInstanceToken: token,
  };
}

function liveTab(documentId: string, path = `/${documentId}.md`) {
  return {
    kind: "tracked" as const,
    documentId,
    scheme: "manuscript" as const,
    path,
    name: path.slice(1),
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
  };
}

function rig() {
  const owner = new AccountPostApplyDispositionOwner("account-a", {
    replaceExactRoomNames: () => undefined,
  });
  const coordinator = new ContextRemovalCoordinator("account-a", {
    draftTabFence: {
      currentFence: (input) =>
        owner.draftTabMutationFence({
          identity: {
            accountId: input.accountId,
            projectId: input.projectId,
            workId: input.workId,
            documentId: input.documentId,
            draftId: input.draftId,
          },
          tabInstanceToken: input.tabInstanceToken,
        }),
    },
  });
  return { owner, coordinator };
}

describe("post-Apply context settlement", () => {
  beforeEach(() => {
    useContextTabsStore.setState({
      byProject: {},
      _reviewOverlayByProject: {},
      _workspaceHydrated: false,
    });
    useContextTabsStore.getState().openTab("project-a", draftTab());
  });

  it("rejects draft-only Close byte-identically while Apply is unresolved", () => {
    const { owner, coordinator } = rig();
    const before = structuredClone(getContextTabs("project-a"));
    const reserved = owner.reserveApply({
      identity,
      presentation: { documentName: "Chapter", contextPath: "/chapter.md", owningWorkLabel: null },
      obligations: {
        draftTab: {
          kind: "draft-only",
          reviewWorkId: "work-a",
          reviewDraftId: "draft-a",
          tabInstanceToken: "tab-a",
        },
        branch: { kind: "generation-qualified", reviewRoomName: "branch-a" },
      },
    });
    expect(reserved.kind).toBe("reserved");
    expect(coordinator.writerClose("project-a", "document-a")).toEqual({
      kind: "apply-disposition-pending",
    });
    expect(getContextTabs("project-a")).toEqual(before);
  });

  it("closes a discarded draft-only tab and replaces its address with the adjacent tab", async () => {
    const neighbor = {
      kind: "tracked" as const,
      documentId: "document-b",
      scheme: "manuscript" as const,
      path: "/next.md",
      name: "next.md",
      editable: true as const,
      filetype: "markdown" as const,
      schemaType: "document" as const,
    };
    useContextTabsStore.getState().openTab("project-a", neighbor);
    await useContextTabsStore.getState().selectTab("project-a", "work-a", "document-a");
    let search: ProjectSearch = {
      screen: "context",
      scheme: "manuscript",
      path: "/chapter.md",
      work: "work-a",
    };
    const replaceAddress = vi.fn(
      (_projectId: string, update: (value: ProjectSearch) => ProjectSearch) => {
        search = update(search);
        return undefined;
      },
    );
    const coordinator = new ContextRemovalCoordinator("account-a", {
      route: {
        readSearch: () => search,
        updateSearch: replaceAddress,
        transition: async () => ({ kind: "applied" }),
      },
    });
    coordinator.registerRoutePort(
      "project-a",
      {
        readSearch: () => search,
        updateSearch: replaceAddress,
        transition: async () => ({ kind: "applied" }),
      },
      "work-a",
    );
    const revision = coordinator.beginRouteSelection("project-a", {
      scheme: "manuscript",
      path: "/chapter.md",
      workId: "work-a",
    });
    coordinator.bindRouteSelection("project-a", revision, {
      kind: "server",
      documentId: "document-a",
    });

    expect(coordinator.discardDraft("project-a", "work-a", "document-a")).toMatchObject({
      kind: "active-fallback",
      fallback: { documentId: "document-b" },
    });
    expect(getContextTabs("project-a")).toMatchObject({
      tabs: [{ documentId: "document-b" }],
      selectedTabIdByWork: { "work-a": "document-b" },
    });
    expect(search).toMatchObject({ screen: "context", scheme: "manuscript", path: "/next.md" });
    expect(replaceAddress).toHaveBeenCalledOnce();
  });

  it("settles only the exact tab token and treats a replacement as an obsolete old obligation", async () => {
    const { coordinator } = rig();
    const base = {
      identity,
      entryVersion: 7,
      dispositionToken: 9,
      draftTab: {
        kind: "draft-only" as const,
        reviewWorkId: "work-a",
        reviewDraftId: "draft-a",
        tabInstanceToken: "tab-a",
      },
    };
    await expect(
      coordinator.settleDraftRecovery({ ...base, disposition: "live-ready" }),
    ).resolves.toMatchObject({
      kind: "metadata-resolved",
      dispositionToken: 9,
    });
    expect(useContextTabsStore.getState().byProject["project-a"]?.tabs[0]).not.toHaveProperty(
      "draftOnly",
    );

    useContextTabsStore.getState().openTab("project-a", draftTab("replacement"));
    const before = structuredClone(getContextTabs("project-a"));
    await expect(
      coordinator.settleDraftRecovery({ ...base, disposition: "writer-abandoned" }),
    ).resolves.toMatchObject({ kind: "obsolete-obligation", dispositionToken: 9 });
    expect(getContextTabs("project-a")).toEqual(before);
  });

  it("promotes an applied draft overlay before live-readiness recovery", async () => {
    const { coordinator } = rig();
    const tab = getContextTabs("project-a").tabs[0];
    if (tab?.kind !== "tracked") throw new Error("Expected tracked draft tab");

    await expect(coordinator.promoteAppliedDraft("project-a", tab)).resolves.toBe(true);

    expect(useContextTabsStore.getState()._reviewOverlayByProject["project-a"]?.tabs ?? []).toEqual(
      [],
    );
    expect(useContextTabsStore.getState().byProject["project-a"]?.tabs).toMatchObject([
      { documentId: "document-a" },
    ]);
    expect(useContextTabsStore.getState().byProject["project-a"]?.tabs[0]).not.toHaveProperty(
      "draftOnly",
    );
  });

  it("replaces an address-first durable member with the one draft-only membership", () => {
    useContextTabsStore.setState({ byProject: {}, _reviewOverlayByProject: {} });
    useContextTabsStore.getState().openTab("project-a", liveTab("document-a", "/chapter.md"));
    useContextTabsStore.getState().openTab("project-a", draftTab());

    expect(useContextTabsStore.getState().byProject["project-a"]?.tabs ?? []).toEqual([]);
    expect(getContextTabs("project-a").tabs).toMatchObject([
      { documentId: "document-a", draftOnly: true },
    ]);
    const receipt = new ContextRemovalCoordinator("account-a").discardDraft(
      "project-a",
      "work-a",
      "document-a",
    );
    expect(receipt.kind).not.toBe("noop");
    expect(getContextTabs("project-a").tabs).toEqual([]);
  });

  it("uses the original order when the selected last draft falls back", async () => {
    useContextTabsStore.getState().openTab("project-a", liveTab("document-b"));
    useContextTabsStore.getState().openTab("project-a", liveTab("document-c"));
    // Put the draft at the end so the ordinary close rule chooses its previous neighbour.
    const original = getContextTabs("project-a").tabs;
    await useContextTabsStore.getState().reorderTabs("project-a", 0, 2);
    expect(original).toHaveLength(3);
    await useContextTabsStore.getState().selectTab("project-a", "work-a", "document-a");
    const route = {
      readSearch: (): ProjectSearch => ({ screen: "work", work: "work-a" }),
      updateSearch: () => undefined,
      transition: async () => ({ kind: "applied" as const }),
    };
    const coordinator = new ContextRemovalCoordinator("account-a", { route });
    coordinator.registerRoutePort("project-a", route, "work-a");

    expect(coordinator.discardDraft("project-a", "work-a", "document-a")).toMatchObject({
      kind: "active-fallback",
      fallback: { documentId: "document-c" },
    });
  });

  it("restores the last discarded draft in front when only its own chooser navigation occurred", async () => {
    let navigationRevision = 0;
    let restored = 0;
    let search: ProjectSearch = {
      screen: "context",
      scheme: "manuscript",
      path: "/chapter.md",
      work: "work-a",
    };
    const route = {
      readSearch: () => search,
      updateSearch: (_projectId: string, update: (value: ProjectSearch) => ProjectSearch) => {
        search = update(search);
        navigationRevision += 1;
        return Promise.resolve();
      },
      transition: async () => ({ kind: "applied" as const }),
      captureCurrentNavigation: () => {
        const captured = navigationRevision;
        return () => navigationRevision === captured;
      },
      restoreDraft: async () => {
        restored += 1;
        return { kind: "applied" as const };
      },
    };
    const coordinator = new ContextRemovalCoordinator("account-a", { route });
    coordinator.registerRoutePort("project-a", route, "work-a");
    const revision = coordinator.beginRouteSelection("project-a", {
      scheme: "manuscript",
      path: "/chapter.md",
      workId: "work-a",
    });
    coordinator.bindRouteSelection("project-a", revision, {
      kind: "server",
      documentId: "document-a",
    });
    const receipt = coordinator.discardDraft("project-a", "work-a", "document-a");
    if (!("rollback" in receipt)) throw new Error("Expected an optimistic discard receipt");

    await expect(receipt.rollback()).resolves.toEqual({ kind: "foreground-restored" });
    expect(restored).toBe(1);
    expect(getContextTabs("project-a").tabs).toMatchObject([
      { documentId: "document-a", draftOnly: true },
    ]);
  });

  it("keeps a refused old Discard from covering a newer applied generation", async () => {
    const coordinator = new ContextRemovalCoordinator("account-a");
    const receipt = coordinator.discardDraft("project-a", "work-a", "document-a");
    if (!("rollback" in receipt)) throw new Error("Expected an optimistic discard receipt");
    useContextTabsStore.getState().openTab("project-a", draftTab("new-generation"));
    const replacement = getContextTabs("project-a").tabs[0];
    if (replacement?.kind !== "tracked") throw new Error("Expected replacement draft");
    await coordinator.promoteAppliedDraft("project-a", replacement);

    await expect(receipt.rollback()).resolves.toEqual({ kind: "superseded" });
    expect(getContextTabs("project-a").tabs[0]).not.toHaveProperty("draftOnly");
  });

  it("restores in the background after later writer navigation even if it returns to the fallback", async () => {
    useContextTabsStore.getState().openTab("project-a", liveTab("document-b"));
    await useContextTabsStore.getState().selectTab("project-a", "work-a", "document-a");
    let navigationRevision = 0;
    const route = {
      readSearch: (): ProjectSearch => ({
        screen: "context",
        scheme: "manuscript",
        path: "/chapter.md",
        work: "work-a",
      }),
      updateSearch: () => {
        navigationRevision += 1;
        return Promise.resolve();
      },
      transition: async () => ({ kind: "applied" as const }),
      captureCurrentNavigation: () => {
        const captured = navigationRevision;
        return () => navigationRevision === captured;
      },
      restoreDraft: vi.fn(async () => ({ kind: "applied" as const })),
    };
    const coordinator = new ContextRemovalCoordinator("account-a", { route });
    coordinator.registerRoutePort("project-a", route, "work-a");
    const revision = coordinator.beginRouteSelection("project-a", {
      scheme: "manuscript",
      path: "/chapter.md",
      workId: "work-a",
    });
    coordinator.bindRouteSelection("project-a", revision, {
      kind: "server",
      documentId: "document-a",
    });
    const receipt = coordinator.discardDraft("project-a", "work-a", "document-a");
    if (!("rollback" in receipt)) throw new Error("Expected an optimistic discard receipt");
    navigationRevision += 2; // B to C to B is still later writer authority.

    await expect(receipt.rollback()).resolves.toEqual({ kind: "background-restored" });
    expect(route.restoreDraft).not.toHaveBeenCalled();
    expect(getContextTabs("project-a").selectedTabIdByWork["work-a"]).toBe("document-b");
  });

  it("makes a second Discard against the consumed generation a no-op", () => {
    const coordinator = new ContextRemovalCoordinator("account-a");
    expect(coordinator.discardDraft("project-a", "work-a", "document-a")).toHaveProperty(
      "rollback",
    );
    expect(coordinator.discardDraft("project-a", "work-a", "document-a")).toEqual({
      kind: "noop",
    });
  });
});
