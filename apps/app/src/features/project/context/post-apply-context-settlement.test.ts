import { beforeEach, describe, expect, it } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import { AccountPostApplyDispositionOwner } from "../draft-apply-recovery/draft-apply-recovery-owner";
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
      _deskHydrated: false,
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

    const prior = getContextTabs("project-a").tabs;
    await useContextTabsStore
      .getState()
      .reconcileBootstrap("project-a", prior, [draftTab("replacement")]);
    const before = structuredClone(getContextTabs("project-a"));
    await expect(
      coordinator.settleDraftRecovery({ ...base, disposition: "writer-abandoned" }),
    ).resolves.toMatchObject({ kind: "obsolete-obligation", dispositionToken: 9 });
    expect(getContextTabs("project-a")).toEqual(before);
  });
});
