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
});
