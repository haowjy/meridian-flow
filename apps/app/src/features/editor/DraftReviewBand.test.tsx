// @vitest-environment jsdom
/** S-doc: document focus and selective commands through the real review band and provider. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as projectsApi from "@/client/api/projects-api";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import {
  applied,
  createReviewScopeFixture,
  deferredReviewAnswer,
  discarded,
  listed,
  preview,
} from "@/test-support/draft-review-scope";
import { DraftReviewBand } from "./DraftReviewBand";

let fixture: ReturnType<typeof createReviewScopeFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  fixture = createReviewScopeFixture();
  vi.spyOn(projectsApi, "listProjectWorks").mockReturnValue(new Promise(() => {}));
});
afterEach(() => {
  fixture.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const list = () => document.querySelector<HTMLElement>("[data-draft-change-list]");
const row = (id: string) =>
  list()?.querySelector<HTMLElement>(`[data-review-change-row="class-${id}"]`);
const open = () =>
  act(async () =>
    document
      .querySelector<HTMLButtonElement>("[data-draft-review-controls] [data-slot=popover-trigger]")
      ?.click(),
  );

/** Drain bounded query/UI scheduling under act; never advance a repeating refresh loop wholesale. */
async function settled(check: () => void) {
  for (let attempt = 0; ; attempt += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    try {
      check();
      return;
    } catch (error) {
      if (attempt === 19) throw error;
    }
  }
}

it("focuses this document, then applies and discards its classes without closing the list", async () => {
  const network = fixture.network;
  const other = {
    ...listed,
    documentId: "document-b",
    draftId: "draft-b",
    documentName: "Other chapter",
  };
  network.listWorkDrafts.mockResolvedValue({ drafts: [listed, other] });
  network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
    ...preview,
    draftId: id,
  }));
  const answer = deferredReviewAnswer<ReturnType<typeof applied>>();
  network.applyDraftChanges.mockReturnValueOnce(answer.promise);
  network.discardDraft.mockResolvedValue(discarded(false));
  const navigate = vi.fn();
  await fixture.render(
    async (probe) => {
      await settled(() => expect(probe().editor.groups).toHaveLength(2));
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await settled(() => expect(probe().header.view.items).toHaveLength(2));
      await open();
      expect(list()?.querySelectorAll("[data-review-change-row]")).toHaveLength(2);
      expect(list()?.textContent).not.toContain("Other chapter");
      await act(async () => row("2")?.querySelector<HTMLButtonElement>("button")?.click());
      expect(probe().header.view.focused?.classId).toBe("class-2");
      expect(list()).toBeNull();
      await open();
      await act(async () =>
        row("1")?.querySelector<HTMLButtonElement>('[aria-label="Apply"]')?.click(),
      );
      expect(list()).not.toBeNull();
      expect(row("1")).toBeNull();
      expect(network.applyDraftChanges.mock.calls).toEqual([
        [
          "project-a",
          "work-a",
          "document-a",
          {
            draftId: "draft-a",
            operationIds: ["1"],
            liveRevisionToken: "live-1",
            draftRevisionToken: "draft-1",
          },
        ],
      ]);
      expect(probe().header.view.focused?.classId).toBe("class-2");
      await act(async () => answer.resolve(applied(false, "1")));
      await settled(() => expect(probe().editor.controller.isDisposing).toBe(false));
      await act(async () =>
        row("2")?.querySelector<HTMLButtonElement>('[aria-label="Discard"]')?.click(),
      );
      expect(network.discardDraft.mock.calls).toEqual([
        [
          "project-a",
          "work-a",
          "document-a",
          {
            draftId: "draft-a",
            operationIds: ["2"],
            liveRevisionToken: "live-1",
            draftRevisionToken: "draft-1",
          },
        ],
      ]);
      expect(list()).not.toBeNull();
      expect(row("2")).toBeNull();
      await settled(() => expect(probe().editor.controller.isDisposing).toBe(false));
      expect(navigate).not.toHaveBeenCalled();
    },
    {
      surface: <DraftReviewBand documentId="document-a" draftId="draft-a" onOpenDraft={navigate} />,
      host: (children) => (
        <I18nProvider i18n={i18n}>
          <TooltipProvider>
            <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
              {children}
            </ProjectNavigationProvider>
          </TooltipProvider>
        </I18nProvider>
      ),
    },
  );
});
