// @vitest-environment jsdom
/** S-phone: the real sheet's document authority and commands over a surviving mounted manuscript. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { EditorContent } from "@tiptap/react";
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as projectsApi from "@/client/api/projects-api";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocumentSession } from "@/core/editor/document-session";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import {
  createReviewScopeFixture,
  deferredReviewAnswer,
  discarded,
  listed,
  operation,
  preview,
} from "@/test-support/draft-review-scope";
import { createStandaloneEditor } from "@/test-support/standalone-editor";
import { MobileDocumentHost } from "./MobileDocumentHost";
import { MobileDocumentReview } from "./MobileDocumentReview";
import type { MobileDocumentRoute } from "./mobile-document-route";

// Editor and live-room acquisition are process boundaries; review queries, commands,
// phone route host and paint frame remain real.
vi.mock("../context/ContextEditorMountHost", () => ({
  ContextEditorMountHost: ({ activeTabId }: { activeTabId: string }) => (
    <p>{activeTabId === "document-a" ? "D prose" : "E prose"}</p>
  ),
}));
vi.mock("../context/use-live-document-binding", () => ({
  useLiveDocumentBinding: () => ({ state: { kind: "idle" }, retry: () => {} }),
}));
vi.mock("../context/use-refused-edits-reopen", () => ({
  useRefusedEditsReopen: () => null,
}));

let fixture: ReturnType<typeof createReviewScopeFixture>;
let manuscript: ReturnType<typeof createStandaloneEditor>;
let room: DocumentSession;
const navigate = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  navigate.mockClear();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  manuscript = createStandaloneEditor({ content: "<p>The writer's manuscript survives.</p>" });
  room = new DocumentSession({ roomKey: "review-room-a", persistence: { kind: "none" } });
  // Refresh subscription only. This journey does not certify transport or review paint (#731).
  const registry = {
    retainBranchRooms: () => {},
    releaseBranchRooms: () => {},
    getBranchRoom: () => room,
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
  vi.useRealTimers();
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
      await settled(() => expect(probe().editor.files).toHaveLength(2));
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await settled(() => expect(probe().header.view.items).toHaveLength(2));
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
      await settled(() => expect(probe().editor.controller.isDisposing).toBe(false));
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
      await settled(() => expect(probe().editor.controller.isDisposing).toBe(false));
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

it("keeps last-change feedback in the sheet flow and gives chat links phone targets", async () => {
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  fixture.network.getDraftPreview.mockResolvedValue({
    ...preview,
    operations: [{ ...operation("1"), actorThreadId: "thread-a", actorThreadTitle: "Lore" }],
  });
  fixture.network.discardDraft.mockResolvedValue(discarded(true));
  await fixture.render(
    async (probe) => {
      await settled(() => expect(probe().editor.files).toHaveLength(1));
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await settled(() => expect(probe().header.view.items).toHaveLength(1));
      await act(async () =>
        probe().editor.controller.setInlineReviewShown("document-a", "draft-a", true),
      );
      await click("Show the 1 change");
      const chatLink = sheet()?.querySelector<HTMLButtonElement>(
        '[title="Open the chat that wrote this change"]',
      );
      expect(chatLink).not.toBeNull();
      expect.soft(chatLink?.classList.contains("min-h-11")).toBe(true);
      await click("Discard", sheet() as ParentNode);
      await settled(() => expect(probe().header.finished).toBe(true));
      const toast = sheet()?.querySelector<HTMLElement>("[data-review-toast]");
      expect(toast?.textContent).toBe("Discarded");
      expect(toast?.classList.contains("static")).toBe(true);
      expect(toast?.classList.contains("bottom-full")).toBe(false);
      expect(sheet()?.textContent).toContain("No changes left");
    },
    {
      surface: (
        <MobileDocumentReview documentId="document-a">
          <div />
        </MobileDocumentReview>
      ),
      host: (children) => (
        <I18nProvider i18n={i18n}>
          <TooltipProvider>
            <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
              <ChatThreadNavigationProvider onOpenThread={navigate}>
                {children}
              </ChatThreadNavigationProvider>
            </ProjectNavigationProvider>
          </TooltipProvider>
        </I18nProvider>
      ),
    },
  );
});

it("holds D's phone review across Discard navigation while E's preview is held", async () => {
  const next = {
    ...listed,
    documentId: "document-b",
    draftId: "draft-b",
    documentName: "E",
    contextPath: "/e.md",
  };
  const answer = deferredReviewAnswer<typeof preview>();
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed, next] });
  fixture.network.getDraftPreview.mockImplementation((_p, _w, _d, id) =>
    id === "draft-b" ? answer.promise : Promise.resolve(preview),
  );
  fixture.network.discardDraft.mockResolvedValue(discarded(true));
  const route = (id: string, pending = false): MobileDocumentRoute => ({
    requested: true,
    scheme: "manuscript",
    path: id === "document-a" ? "/d.md" : "/e.md",
    tab: pending
      ? null
      : {
          kind: "tracked",
          documentId: id,
          scheme: "manuscript",
          path: id === "document-a" ? "/d.md" : "/e.md",
          name: id,
          editable: true,
          filetype: "markdown",
          schemaType: "document",
          draftOnly: true,
          reviewWorkId: "work-a",
          reviewDraftId: id === "document-a" ? "draft-a" : "draft-b",
        },
    catalogResolved: true,
    addressState: pending ? "pending" : "settled",
    isError: false,
    isFetching: false,
  });
  let open: (pending: boolean) => void = () => {};
  function PhoneRoute() {
    const [destination, setDestination] = useState(route("document-a"));
    open = (pending) => setDestination(route("document-b", pending));
    return <MobileDocumentHost projectId="project-a" editorWorkId="work-a" route={destination} />;
  }
  await fixture.render(
    async (probe) => {
      await settled(() => expect(probe().editor.files).toHaveLength(2));
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await settled(() => expect(probe().header.view.items).toHaveLength(2));
      await act(async () =>
        probe().editor.controller.setInlineReviewShown("document-a", "draft-a", true),
      );
      await settled(() =>
        expect(document.querySelector("[data-phone-review-header]")).not.toBeNull(),
      );
      navigate.mockImplementationOnce(async () => {
        open(true);
        probe().editor.controller.enterInlineReview("document-b", "draft-b");
      });
      await act(async () =>
        document
          .querySelector<HTMLElement>(
            "[data-phone-review-header] [data-slot=dropdown-menu-trigger]",
          )
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      await click("Discard draft");
      await settled(() =>
        expect(fixture.network.getDraftPreview).toHaveBeenCalledWith(
          "project-a",
          "work-a",
          "document-b",
          "draft-b",
          expect.any(AbortSignal),
        ),
      );
      const held = document.querySelector("[data-paint-hold]");
      expect(held?.textContent).toContain("D prose");
      expect(held?.querySelector("[data-phone-review-header]")).not.toBeNull();
      expect(held?.textContent).not.toContain("Opening document…");
      expect(held?.getAttribute("aria-hidden")).toBe("true");
      expect(held?.hasAttribute("inert")).toBe(true);
      await act(async () => {
        answer.resolve({ ...preview, draftId: "draft-b" });
        open(false);
      });
      await settled(() => expect(document.querySelector("[data-paint-hold]")).toBeNull());
      expect(document.querySelector("[data-paint-page]")?.textContent).toContain("E prose");
    },
    {
      surface: <PhoneRoute />,
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
