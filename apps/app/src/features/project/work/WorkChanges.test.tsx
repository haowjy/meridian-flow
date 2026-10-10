// @vitest-environment jsdom
/** S-work: unopened selective commands and filtered whole-Work authority, independent of Editor A. */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, type ReactNode, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocumentSession } from "@/core/editor/document-session";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import {
  applied,
  createReviewScopeFixture,
  deferredReviewAnswer,
  discarded,
  listed,
  preview,
  workC,
} from "@/test-support/draft-review-scope";
import { settleReact } from "@/test-support/react-dom-harness";
import { WorkChanges } from "./WorkChanges";

let fixture: ReturnType<typeof createReviewScopeFixture>;
let room: DocumentSession;
const retain = vi.fn();
const navigate = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  navigate.mockClear();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  room = new DocumentSession({ roomKey: "room-draft-a", persistence: { kind: "none" } });
  retain.mockClear();
  fixture = createReviewScopeFixture({
    registry: {
      retainBranchRooms: retain,
      releaseBranchRooms: () => {},
      getBranchRoom: () => room,
    } as unknown as LiveDocumentSessionRegistry,
  });
  vi.spyOn(handoff, "useOpenEditorReview").mockReturnValue(navigate);
});
afterEach(() => {
  fixture.dispose();
  room.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const draftB = {
  ...listed,
  documentId: "document-b",
  draftId: "draft-b",
  documentName: "Chapter 13",
  contextPath: "/chapter-13.md",
};
const draftC = {
  ...listed,
  documentId: "document-c",
  draftId: "draft-c",
  documentName: "Filtered chapter",
  contextPath: "/filtered.md",
};
function DesktopEnvironment({ children }: { children: ReactNode }) {
  window.matchMedia ??= () =>
    ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  return children;
}
function Page() {
  const [filter, setFilter] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setFilter(true)}>
        Filter files
      </button>
      <WorkChanges
        projectId="project-a"
        work={workC}
        matchesSearch={(name) => !filter || name === "Chapter 13"}
      />
    </>
  );
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent)?.trim() === label,
  );
const click = (label: string) =>
  act(async () => {
    expect(button(label)).toBeDefined();
    button(label)?.click();
  });

/** Drain bounded query/UI scheduling under act; never advance a repeating refresh loop wholesale. */

it("applies an unopened C row, then discards every C draft despite filtering without moving Editor A", async () => {
  const network = fixture.network;
  network.listWorkDrafts.mockImplementation(async (_project, work) => ({
    drafts: work === workC.id ? [draftB, draftC] : [listed],
  }));
  network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
    ...preview,
    draftId: id,
    reviewRoomName: `room-${id}`,
  }));
  const answer = deferredReviewAnswer<ReturnType<typeof applied>>();
  network.applyDraftChanges.mockReturnValueOnce(answer.promise);
  network.discardDraft.mockImplementation(async (_p, _w, _d, request) => ({
    ...discarded(true),
    draftId: request.draftId,
  }));
  await fixture.render(
    async (probe) => {
      await settleReact(() => expect(probe().third.files).toHaveLength(2));
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await settleReact(() => expect(probe().header.view.items).toHaveLength(2));
      const editorReview = probe().editor.controller.inlineReview;
      await settleReact(() => expect(retain).toHaveBeenCalled());
      await click("Changes in Chapter 13");
      await settleReact(() =>
        expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(2),
      );
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-review-change-row="class-1"] [aria-label="Apply"]',
          )
          ?.click(),
      );
      expect(network.applyDraftChanges.mock.calls).toEqual([
        [
          "project-a",
          "work-c",
          "document-b",
          {
            draftId: "draft-b",
            operationIds: ["1"],
            liveRevisionToken: "live-1",
            draftRevisionToken: "draft-1",
          },
        ],
      ]);
      expect(document.querySelector('[data-review-change-row="class-1"]')).toBeNull();
      expect(probe().editor.controller.inlineReview).toEqual(editorReview);
      await act(async () => answer.resolve({ ...applied(false, "1"), draftId: "draft-b" }));
      await settleReact(() => expect(probe().third.commands.isDisposing).toBe(false));
      await click("Filter files");
      expect(button("Changes in Filtered chapter")).toBeUndefined();
      await act(async () =>
        button("All changes")?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
      await click("Discard all changes");
      expect(document.body.textContent).toContain("Discard all changes?");
      expect(network.discardDraft).not.toHaveBeenCalled();
      await click("Discard");
      await settleReact(() =>
        expect(network.discardDraft.mock.calls).toEqual([
          ["project-a", "work-c", "document-b", { draftId: "draft-b" }],
          ["project-a", "work-c", "document-c", { draftId: "draft-c" }],
        ]),
      );
      await settleReact(() => expect(probe().third.commands.isDisposing).toBe(false));
      expect(probe().editor.controller.inlineReview).toEqual(editorReview);
      expect(probe().header.view.items.map((item) => item.change.operationIds)).toEqual([
        ["1"],
        ["2"],
      ]);
      expect(
        retain.mock.calls.flatMap(([, rooms]) =>
          rooms.map((room: { roomKey: string }) => room.roomKey),
        ),
      ).toEqual(["room-draft-a"]);
      expect(navigate).not.toHaveBeenCalled();
    },
    {
      surface: <Page />,
      host: (children) => (
        <DesktopEnvironment>
          <I18nProvider i18n={i18n}>
            <TooltipProvider>
              <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
                <ChatThreadNavigationProvider onOpenThread={navigate}>
                  {children}
                </ChatThreadNavigationProvider>
              </ProjectNavigationProvider>
            </TooltipProvider>
          </I18nProvider>
        </DesktopEnvironment>
      ),
    },
  );
});
