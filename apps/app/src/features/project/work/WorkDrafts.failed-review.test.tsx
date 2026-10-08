// @vitest-environment jsdom
/** A Review that fails to open shows on the draft's Work Files row, and the next attempt clears it. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { EditorReviewHandoffProvider } from "../dock/editor-review-handoff";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import { WorkDrafts } from "./WorkDrafts";

const group = {
  documentId: "document-a",
  documentName: "chapter.md",
  contextPath: "/chapter.md",
  draft: { draftId: "draft-a", isNewDocument: true },
};

vi.mock("@/client/query/useWorkDrafts", () => ({
  useWorkDrafts: () => ({ status: "ready", groups: [group], refetch: vi.fn() }),
  activeWorkDraftGroups: (groups: unknown[]) => groups,
}));

const MESSAGE = "Couldn't open this draft. Try again.";

function render(openContextRoute: OpenContextRoute, run: () => Promise<void>) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <EditorReviewHandoffProvider projectId="project-a" openContextRoute={openContextRoute}>
        <WorkDrafts
          projectId="project-a"
          workId={"work-a" as ParsedRequestId}
          matchesSearch={() => true}
        />
      </EditorReviewHandoffProvider>
    </I18nProvider>,
    run,
  );
}

const clickRow = () =>
  act(async () => document.querySelector<HTMLButtonElement>("button:not([aria-label])")?.click());

describe("WorkDrafts failed Review", () => {
  beforeEach(() => {
    resetDraftCommandRecords();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows the error on the launching row and clears it on the next attempt", async () => {
    const open = vi
      .fn<OpenContextRoute>()
      .mockRejectedValueOnce(new Error("The reviewed document could not be located"))
      .mockResolvedValue({ kind: "applied" });
    await render(open, async () => {
      expect(document.querySelector("[role=alert]")).toBeNull();
      await clickRow();
      expect(document.querySelector("[role=alert]")?.textContent).toBe(MESSAGE);
      expect(console.error).toHaveBeenCalled();
      await clickRow();
      expect(document.querySelector("[role=alert]")).toBeNull();
    });
  });
});
