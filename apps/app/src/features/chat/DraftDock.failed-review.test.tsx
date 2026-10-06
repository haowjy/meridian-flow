// @vitest-environment jsdom
/** A Review that fails to open shows under the composer strip's draft, and the next attempt clears it. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { EditorReviewHandoffProvider } from "@/features/project/dock/editor-review-handoff";
import type { OpenContextRoute } from "@/features/project/routing/ProjectNavigationContext";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftDock, useDraftDock } from "./DraftDock";
import { DraftReviewBoundary, type DraftReviewContextValue } from "./DraftReviewProvider";

const review = {
  controller: {
    projectId: "project-a",
    workId: "work-a",
    isDisposing: false,
    dispositionLocked: false,
    dockDispositionError: null,
  },
  groups: [
    {
      documentId: "document-a",
      documentName: "chapter.md",
      contextPath: "/chapter.md",
      draft: { draftId: "draft-a", status: "active", isNewDocument: true },
    },
  ],
} as unknown as DraftReviewContextValue;

function Dock() {
  return <DraftDock dock={useDraftDock({ generating: false })} />;
}

function render(openContextRoute: OpenContextRoute, run: () => Promise<void>) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <EditorReviewHandoffProvider projectId="project-a" openContextRoute={openContextRoute}>
        <DraftReviewBoundary value={review}>
          <Dock />
        </DraftReviewBoundary>
      </EditorReviewHandoffProvider>
    </I18nProvider>,
    run,
  );
}

describe("DraftDock failed Review", () => {
  beforeEach(() => {
    resetDraftCommandRecords();
    vi.spyOn(console, "error").mockImplementation(() => {});
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
