// @vitest-environment jsdom
/** Draft-only Discard projects disappearance immediately and restores it on refusal. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type DraftReviewController, useDraftReviewController } from "./useDraftReviewController";

let rejectDiscard: ((reason: unknown) => void) | null = null;
const removeDraftTab = vi.fn(() => {
  const tab = getContextTabs("project-a").tabs.find(
    (candidate) => candidate.documentId === "document-a",
  );
  if (
    tab?.kind !== "tracked" ||
    !tab.tabInstanceId ||
    !tab.reviewWorkId ||
    !tab.reviewDraftId ||
    !tab.tabInstanceToken
  )
    return;
  useContextTabsStore.getState().consumeReviewTab("project-a", {
    documentId: tab.documentId,
    tabInstanceId: tab.tabInstanceId,
    reviewWorkId: tab.reviewWorkId,
    reviewDraftId: tab.reviewDraftId,
    tabInstanceToken: tab.tabInstanceToken,
  });
});

vi.mock("@/client/api/drafts-api", () => ({
  getDraftPreview: vi.fn(async () => ({
    status: "active",
    draftId: "draft-a",
    reviewRoomName: "review-room-a",
  })),
}));

vi.mock("@/client/query/useDraftReviewMutations", () => ({
  useApplyDraft: () => ({ mutateAsync: vi.fn() }),
  useDiscardDraft: () => ({
    mutateAsync: () =>
      new Promise((_resolve, reject) => {
        rejectDiscard = reject;
      }),
  }),
}));

vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ discardDraft: removeDraftTab }),
}));

vi.mock("@/features/project/draft-apply-recovery/DraftApplyRecoveryProvider", () => ({
  usePostApplyAccountId: () => "account-a",
}));

vi.mock("@/features/project/draft-apply-recovery/ProjectDraftApplyRecoveryExecutor", () => ({
  useProjectDraftApplyRecovery: () => ({
    awaitInitialOutcome: vi.fn(),
  }),
}));

const draftTab = {
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
  tabInstanceToken: "token-a",
};

let controller: DraftReviewController | null = null;

function CaptureController() {
  controller = useDraftReviewController("project-a", "work-a");
  return null;
}

function Providers({ children, open }: { children: ReactNode; open: OpenContextRoute }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <ProjectNavigationProvider
        openContextRoute={open}
        captureNavigation={() => () => true}
        screen="context"
      >
        {children}
      </ProjectNavigationProvider>
    </QueryClientProvider>
  );
}

describe("draft-only Discard", () => {
  beforeEach(() => {
    controller = null;
    rejectDiscard = null;
    removeDraftTab.mockClear();
    useContextTabsStore.setState({
      byProject: {},
      _reviewOverlayByProject: {},
      _workspaceHydrated: false,
    });
    useContextTabsStore.getState().openTab("project-a", draftTab);
  });

  it("closes immediately, then restores the tab, review, and address when Discard fails", async () => {
    const open = vi.fn<OpenContextRoute>(async (_target, options) => {
      if (options?.tab) useContextTabsStore.getState().openTab("project-a", options.tab);
      return { kind: "applied" as const };
    });
    await withReactRoot(
      <Providers open={open}>
        <CaptureController />
      </Providers>,
      async () => {
        await act(async () => controller?.enterInlineReview("document-a", "draft-a"));
        let disposition: Promise<unknown> | undefined;
        await act(async () => {
          disposition = controller?.discard("document-a", "draft-a");
        });

        expect(removeDraftTab).toHaveBeenCalledWith("project-a", "work-a", "document-a");
        expect(getContextTabs("project-a").tabs).toEqual([]);

        await act(async () => {
          rejectDiscard?.(new Error("offline"));
          await disposition;
        });

        expect(open).toHaveBeenCalledWith(
          expect.objectContaining({ documentId: "document-a", path: "/chapter.md" }),
          expect.objectContaining({
            replace: true,
            draftId: "draft-a",
            tab: expect.objectContaining(draftTab),
          }),
        );
        expect(getContextTabs("project-a").tabs).toMatchObject([
          { documentId: "document-a", draftOnly: true },
        ]);
        expect(controller?.inlineReview).toMatchObject({
          documentId: "document-a",
          draftId: "draft-a",
        });
        expect(controller?.inlineReviewMessage).toEqual({
          code: "discard-offline",
          tone: "error",
        });
      },
    );
  });
});
