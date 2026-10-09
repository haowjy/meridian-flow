// @vitest-environment jsdom
/** A refused Discard shows on the draft's Changes to review row until it is dismissed. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failDraftCommand, resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { WorkChanges } from "./WorkChanges";

const group = {
  documentId: "document-a",
  documentName: "chapter.md",
  contextPath: "/chapter.md",
  draft: { draftId: "draft-a", status: "active", isNewDocument: true },
};

vi.mock("./useWorkReviewScope", () => ({
  useWorkReviewScope: () => ({
    controller: { dispositionLocked: false, disposeDrafts: vi.fn() },
    groups: [group],
    drafts: { status: "ready", refetch: vi.fn() },
  }),
}));
vi.mock("@/hooks/use-phone-shell", () => ({ usePhoneShell: () => false }));
vi.mock("../dock/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: vi.fn() }),
}));

function render(run: () => Promise<void> | void) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <WorkChanges
        projectId="project-a"
        workId={"work-a" as ParsedRequestId}
        matchesSearch={() => true}
      />
    </I18nProvider>,
    run,
  );
}

describe("WorkChanges refused Discard", () => {
  beforeEach(() => resetDraftCommandRecords());

  it("shows the error on the draft's row and clears it on dismiss", async () => {
    await render(async () => {
      expect(document.querySelector("[role=alert]")).toBeNull();
      await act(async () =>
        failDraftCommand(
          {
            projectId: "project-a",
            workId: "work-a",
            documentId: "document-a",
            draftId: "draft-a",
          },
          { code: "discard-offline" },
        ),
      );
      expect(document.querySelector("[role=alert]")?.textContent).toBe(
        "Couldn't discard. Check your connection and try again.",
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>("[role=alert] button[aria-label=Dismiss]")
          ?.click(),
      );
      expect(document.querySelector("[role=alert]")).toBeNull();
    });
  });
});
