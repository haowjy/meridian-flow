// @vitest-environment jsdom
/** S-doc: document focus and selective commands through the real review band and provider. */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as projectsApi from "@/client/api/projects-api";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { MobileDocumentReview } from "@/features/project/mobile/MobileDocumentReview";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import {
  applied,
  createReviewScopeFixture,
  deferredReviewAnswer,
  discarded,
  listed,
  preview,
} from "@/test-support/draft-review-scope";
import {
  createReviewEditor,
  destroyReviewEditors,
  model,
  posOf,
  setModel,
  textHunk,
} from "@/test-support/inline-review-editor";
import { settleReact } from "@/test-support/react-dom-harness";
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
  destroyReviewEditors();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      await settleReact(() => expect(probe().editor.files).toHaveLength(2));
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await settleReact(() => expect(probe().header.view.items).toHaveLength(2));
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
      await settleReact(() => expect(probe().editor.controller.isDisposing).toBe(false));
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
      await settleReact(() => expect(probe().editor.controller.isDisposing).toBe(false));
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

it.each([
  "desktop",
  "phone",
] as const)("%s steps with marks hidden without restoring them", async (surface) => {
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  fixture.network.getDraftPreview.mockResolvedValue(preview);
  const navigate = vi.fn();
  vi.spyOn(handoff, "useOpenEditorReview").mockReturnValue(navigate);
  await fixture.render(
    async (probe) => {
      await settleReact(() => expect(probe().editor.files).toHaveLength(1));
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await settleReact(() => expect(probe().header.view.items).toHaveLength(2));
      await act(async () => {
        probe().editor.controller.setInlineReviewShown("document-a", "draft-a", true);
        probe().editor.controller.setMarksVisible(false);
      });
      vi.stubGlobal("HTMLElement", window.HTMLElement);
      window.matchMedia = vi.fn().mockReturnValue({ matches: true });
      const { editor } = createReviewEditor(["Alpha", "Beta"]);
      setModel(
        editor,
        model(
          preview.operations,
          ["Alpha", "Beta"].map((text, index) => {
            const from = posOf(editor, text);
            return textHunk(editor, `h${index}`, [String(index + 1)], {
              from,
              to: from + text.length,
            });
          }),
        ),
      );
      editor.commands.setInlineReviewMarksVisible(false);
      probe().editor.controller.registerInlineReviewRuntime({
        documentId: "document-a",
        draftId: "draft-a",
        editor,
      });
      const paragraphs = [...editor.view.dom.querySelectorAll("p")];
      const scrolls = paragraphs.map((paragraph) => {
        const scroll = vi.fn();
        paragraph.scrollIntoView = scroll;
        return scroll;
      });
      for (const [label, classId] of [
        ["Next change", "class-1"],
        ["Previous change", "class-2"],
      ]) {
        const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
        expect(button).not.toBeNull();
        expect(button?.disabled).toBe(false);
        await act(async () => button?.click());
        expect(probe().header.view.focused?.classId).toBe(classId);
        expect(probe().editor.controller.marksVisible).toBe(false);
        expect(scrolls[classId === "class-1" ? 0 : 1]).toHaveBeenCalled();
        expect(editor.view.dom.querySelector("[data-review-operations]")).toBeNull();
      }
    },
    {
      surface:
        surface === "desktop" ? (
          <DraftReviewBand documentId="document-a" draftId="draft-a" onOpenDraft={navigate} />
        ) : (
          <MobileDocumentReview documentId="document-a">
            <div />
          </MobileDocumentReview>
        ),
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
