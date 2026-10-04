// @vitest-environment jsdom
/** A refused Discard shows on the draft's Work Files row until it is dismissed. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failDraftCommand, resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { withReactRoot } from "@/test-support/react-dom-harness";
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
vi.mock("../dock/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: vi.fn() }),
}));

function render(run: () => Promise<void> | void) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  return withReactRoot(
    <I18nProvider i18n={i18n}>
      <WorkDrafts
        projectId="project-a"
        workId={"work-a" as ParsedRequestId}
        matchesSearch={() => true}
      />
    </I18nProvider>,
    run,
  );
}

describe("WorkDrafts refused Discard", () => {
  beforeEach(() => resetDraftCommandRecords());

  it("shows the error on the draft's row and clears it on dismiss", async () => {
    await render(async () => {
      expect(document.querySelector("[role=alert]")).toBeNull();
      await act(async () =>
        failDraftCommand({ documentId: "document-a", draftId: "draft-a" }, "discard-offline"),
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
