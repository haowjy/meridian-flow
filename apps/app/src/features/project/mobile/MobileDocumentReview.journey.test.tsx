// @vitest-environment jsdom
/** S-phone: the real sheet's document authority and commands over a surviving mounted manuscript. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { EditorContent } from "@tiptap/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Doc } from "yjs";
import * as projectsApi from "@/client/api/projects-api";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import {
  createReviewScopeFixture,
  deferredReviewAnswer,
  discarded,
  listed,
  preview,
} from "@/test-support/draft-review-scope";
import { createStandaloneEditor } from "@/test-support/standalone-editor";
import { MobileDocumentReview } from "./MobileDocumentReview";

let fixture: ReturnType<typeof createReviewScopeFixture>;
let manuscript: ReturnType<typeof createStandaloneEditor>;
let room: Doc;
const navigate = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  resetDraftCommandRecords();
  navigate.mockClear();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  manuscript = createStandaloneEditor({ content: "<p>The writer's manuscript survives.</p>" });
  room = new Doc();
  // Refresh subscription only. This journey does not certify transport or review paint (#731).
  const registry = {
    retainBranchRooms: () => {},
    releaseBranchRooms: () => {},
    getBranchRoom: () => ({ document: room }),
  } as unknown as LiveDocumentSessionRegistry;
  fixture = createReviewScopeFixture({ registry });
  vi.spyOn(projectsApi, "listProjectWorks").mockReturnValue(new Promise(() => {}));
  vi.spyOn(handoff, "useOpenEditorReview").mockReturnValue(navigate);
});
afterEach(() => {
  fixture.dispose();
  manuscript.destroy();
  room.destroy();
  vi.restoreAllMocks();
});
const sheet = () => document.querySelector<HTMLElement>("[data-phone-change-sheet]");
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim() === label,
  );
const click = (label: string, within: ParentNode = document) =>
  act(async () => {
    expect(button(label, within)).toBeDefined();
    button(label, within)?.click();
  });

it("focuses and discards through this document's sheet, keeping its editor through whole Discard", async () => {
  const network = fixture.network;
  network.listWorkDrafts.mockResolvedValue({
    drafts: [
      listed,
      {
        ...listed,
        documentId: "document-b",
        draftId: "draft-b",
        documentName: "Foreign document",
        contextPath: "/foreign.md",
      },
    ],
  });
  network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
    ...preview,
    draftId: id,
  }));
  const selective = deferredReviewAnswer<ReturnType<typeof discarded>>();
  const whole = deferredReviewAnswer<ReturnType<typeof discarded>>();
  network.discardDraft.mockReturnValueOnce(selective.promise).mockReturnValueOnce(whole.promise);
  await fixture.render(
    async (probe) => {
      const editor = manuscript.editor;
      const dom = editor.view.dom;
      expect(document.querySelector(".ProseMirror")).toBe(dom);
      await vi.waitFor(() => expect(probe().editor.groups).toHaveLength(2));
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await vi.waitFor(() => expect(probe().header.view.items).toHaveLength(2));
      // Chrome's painted-review admission is a real controller operation, not invented controller state.
      await act(async () =>
        probe().editor.controller.setInlineReviewShown("document-a", "draft-a", true),
      );
      await click("Show the 2 changes");
      expect(sheet()?.querySelectorAll("[data-review-change-row]")).toHaveLength(2);
      expect(sheet()?.textContent).not.toContain("Foreign document");
      await act(async () =>
        sheet()
          ?.querySelector<HTMLButtonElement>('[data-review-change-row="class-2"] button')
          ?.click(),
      );
      expect(probe().header.view.focused?.classId).toBe("class-2");
      expect(sheet()).toBeNull();
      await click("Show the 2 changes");
      await click(
        "Discard",
        sheet()?.querySelector('[data-review-change-row="class-1"]') as ParentNode,
      );
      expect(sheet()).not.toBeNull();
      expect(sheet()?.querySelector('[data-review-change-row="class-1"]')).toBeNull();
      expect(network.discardDraft.mock.calls).toEqual([
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
      await act(async () => selective.resolve(discarded(false)));
      await vi.waitFor(() => expect(probe().editor.controller.isDisposing).toBe(false));
      expect(sheet()?.querySelector("[data-review-toast]")?.textContent).toContain("Discarded");
      expect(document.querySelectorAll("[data-review-toast]")).toHaveLength(1);
      expect(probe().header.view.focused?.classId).toBe("class-2");
      await click("Close the list", sheet() as ParentNode);
      await act(async () =>
        document
          .querySelector<HTMLElement>(
            "[data-phone-review-header] [data-slot=dropdown-menu-trigger]",
          )
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      await click("Discard draft");
      expect(network.discardDraft.mock.calls[1]).toEqual([
        "project-a",
        "work-a",
        "document-a",
        { draftId: "draft-a" },
      ]);
      await act(async () => whole.resolve(discarded(true)));
      await vi.waitFor(() => expect(probe().editor.controller.isDisposing).toBe(false));
      expect(document.querySelector(".ProseMirror")).toBe(dom);
      expect(editor.isDestroyed).toBe(false);
      await act(async () => editor.commands.insertContent(" Still writing."));
      expect(editor.getText()).toContain("Still writing.");
      expect(navigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ documentId: "document-b", draftId: "draft-b", workId: "work-a" }),
      );
    },
    {
      surface: (
        <MobileDocumentReview documentId="document-a">
          <EditorContent editor={manuscript.editor} />
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
