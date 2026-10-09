// @vitest-environment jsdom
/** A Review that fails to open shows under the composer strip's draft, and the next attempt clears it. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
} from "@/features/draft-review/DraftReviewProvider";
import { EditorReviewHandoffProvider } from "@/features/project/dock/editor-review-handoff";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { operation, preview } from "@/test-support/draft-review-scope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftDock } from "./DraftDock";
import { useDraftDock } from "./useDraftDock";

const mocks = vi.hoisted(() => ({ getDraftPreview: vi.fn() }));
vi.mock("@/client/api/drafts-api", () => mocks);

const chat = { threadId: "thread-a", title: "Pacing pass" };
const review = {
  controller: {
    projectId: "project-a",
    workId: "work-a",
    isDisposing: false,
    dispositionLocked: false,
    inlineReview: null,
  },
  groups: [
    {
      documentId: "document-a",
      documentName: "chapter.md",
      contextPath: "/chapter.md",
      draft: {
        draftId: "draft-a",
        status: "active",
        isNewDocument: true,
        actorThreads: [chat],
        updatedAt: "2026-10-07T00:00:00.000Z",
      },
    },
  ],
} as unknown as DraftReviewContextValue;

function Dock() {
  return <DraftDock dock={useDraftDock({ threadId: "thread-a", generating: false, work: null })} />;
}

function render(openContextRoute: OpenContextRoute, run: () => Promise<void>) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return withReactRoot(
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <EditorReviewHandoffProvider projectId="project-a" openContextRoute={openContextRoute}>
          <DraftReviewBoundary value={review}>
            <Dock />
          </DraftReviewBoundary>
        </EditorReviewHandoffProvider>
      </I18nProvider>
    </QueryClientProvider>,
    run,
  );
}

describe("DraftDock failed Review", () => {
  beforeEach(() => {
    resetDraftCommandRecords();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getDraftPreview.mockResolvedValue({
      ...preview,
      operations: [
        {
          ...operation("1"),
          actorThreadId: chat.threadId,
          actorThreadTitle: chat.title,
        },
      ],
    });
  });

  it("shows the error under the strip and clears it on the next attempt", async () => {
    const open = vi
      .fn<OpenContextRoute>()
      .mockRejectedValueOnce(new Error("Editor review navigation did not settle after retry"))
      .mockResolvedValue({ kind: "applied" });
    const clickReview = () =>
      act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Review draft")
          ?.click(),
      );
    await render(open, async () => {
      await vi.waitFor(() => expect(document.querySelector("[data-draft-dock]")).not.toBeNull());
      expect(document.querySelector("[role=alert]")).toBeNull();
      await clickReview();
      expect(document.querySelector("[role=alert]")?.textContent).toBe(
        "Couldn't open this draft. Try again.",
      );
      await clickReview();
      expect(document.querySelector("[role=alert]")).toBeNull();
    });
  });
});
