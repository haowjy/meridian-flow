// @vitest-environment jsdom
/** S-chat: shared-class batch authority, queued disappearance and independently refused recovery. */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as projectsApi from "@/client/api/projects-api";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import {
  applied,
  createReviewScopeFixture,
  deferredReviewAnswer,
  discarded,
  listed,
  operation,
  preview,
} from "@/test-support/draft-review-scope";
import { settleReact } from "@/test-support/react-dom-harness";
import { DraftDock } from "./DraftDock";
import { useDraftDock } from "./useDraftDock";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const navigate = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  navigate.mockClear();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  fixture = createReviewScopeFixture();
  vi.spyOn(projectsApi, "listProjectWorks").mockReturnValue(new Promise(() => {}));
  vi.spyOn(handoff, "useOpenEditorReview").mockReturnValue(navigate);
});
afterEach(() => {
  fixture.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const pacing = { threadId: "thread-a", title: "Pacing pass" };
const lore = { threadId: "thread-b", title: "Lore pass" };
const draft = (id: string, actors: (typeof pacing)[]) => ({
  ...listed,
  documentId: id,
  draftId: `draft-${id}`,
  documentName: id,
  contextPath: `/${id}.md`,
  actorThreads: actors,
});
const op = (id: string, actor: typeof pacing | null, classId = `class-${id}`) => ({
  ...operation(id),
  closureClassId: classId,
  ...(actor
    ? { actorThreadId: actor.threadId, actorThreadTitle: actor.title }
    : { kind: "writer" as const }),
});
function Strip() {
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  return <DraftDock dock={useDraftDock({ threadId: "thread-a", generating: false })} />;
}
const strip = () => document.querySelector<HTMLElement>("[data-draft-dock]");
const text = () => strip()?.textContent ?? "";
const click = (name: string) =>
  act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === name,
    );
    expect(button).toBeDefined();
    button?.click();
  });

/** Drain bounded query/UI scheduling under act; never advance a repeating refresh loop wholesale. */

it("hides the queued chat batch, restores only the refused file, then discards its shared selection", async () => {
  const network = fixture.network;
  network.listWorkDrafts.mockResolvedValue({
    drafts: [
      draft("chapter-12", [pacing, lore]),
      draft("chapter-14", [pacing]),
      draft("foreign", [lore]),
    ],
  });
  const held = {
    "chapter-12": {
      ...preview,
      draftId: "draft-chapter-12",
      liveRevisionToken: "live-12",
      draftRevisionToken: "draft-12",
      operations: [op("1", pacing), op("2", pacing), op("3", lore, "class-2"), op("4", null)],
    },
    "chapter-14": {
      ...preview,
      draftId: "draft-chapter-14",
      liveRevisionToken: "live-14",
      draftRevisionToken: "draft-14",
      operations: [op("7", pacing), op("8", lore)],
    },
    foreign: { ...preview, draftId: "draft-foreign", operations: [op("9", lore)] },
  };
  network.getDraftPreview.mockImplementation(async (_p, _w, doc) => held[doc as keyof typeof held]);
  const first = deferredReviewAnswer<Awaited<ReturnType<typeof network.applyDraftChanges>>>();
  const second = deferredReviewAnswer<Awaited<ReturnType<typeof network.applyDraftChanges>>>();
  network.applyDraftChanges.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  network.discardDraft.mockResolvedValue({ ...discarded(false), draftId: "draft-chapter-12" });
  await fixture.render(
    async (probe) => {
      await settleReact(() => expect(text()).toContain("3 changes"));
      await click("Apply");
      expect(strip()).toBeNull();
      expect(network.applyDraftChanges.mock.calls).toEqual([
        [
          "project-a",
          "work-a",
          "chapter-12",
          {
            draftId: "draft-chapter-12",
            operationIds: ["1", "2", "3"],
            liveRevisionToken: "live-12",
            draftRevisionToken: "draft-12",
          },
        ],
      ]);
      await act(async () => first.resolve({ status: "stale", draftId: "draft-chapter-12" }));
      await settleReact(() => expect(network.applyDraftChanges).toHaveBeenCalledTimes(2));
      expect(network.applyDraftChanges.mock.calls[1]).toEqual([
        "project-a",
        "work-a",
        "chapter-14",
        {
          draftId: "draft-chapter-14",
          operationIds: ["7"],
          liveRevisionToken: "live-14",
          draftRevisionToken: "draft-14",
        },
      ]);
      await settleReact(() =>
        expect(text()).toContain("This change was updated. Check it and apply again."),
      );
      expect(text()).toContain("2 changes");
      expect(text()).not.toContain("chapter-14");
      expect(text()).not.toContain("foreign");
      await act(async () =>
        second.resolve({ ...applied(false, "7"), draftId: "draft-chapter-14" }),
      );
      await settleReact(() => expect(probe().chat.commands.isDisposing).toBe(false));
      const remaining = await probe().mountDraftChanges({
        projectId: "project-a",
        workId: "work-a",
        documentId: "chapter-14",
        draftId: "draft-chapter-14",
      });
      await settleReact(() =>
        expect(remaining().items.map((item) => item.change.operationIds)).toEqual([["8"]]),
      );
      await click("Discard");
      expect(network.discardDraft.mock.calls).toEqual([
        [
          "project-a",
          "work-a",
          "chapter-12",
          {
            draftId: "draft-chapter-12",
            operationIds: ["1", "2", "3"],
            liveRevisionToken: "live-12",
            draftRevisionToken: "draft-12",
          },
        ],
      ]);
      await settleReact(() => expect(strip()).toBeNull());
      const writer = await probe().mountDraftChanges({
        projectId: "project-a",
        workId: "work-a",
        documentId: "chapter-12",
        draftId: "draft-chapter-12",
      });
      await settleReact(() =>
        expect(writer().items.map((item) => item.change.operationIds)).toEqual([["4"]]),
      );
      expect(navigate).not.toHaveBeenCalled();
      expect(probe().presented.controller.inlineReview).toBeNull();
    },
    {
      chatSurface: <Strip />,
      host: (children) => (
        <I18nProvider i18n={i18n}>
          <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
            <TooltipProvider>{children}</TooltipProvider>
          </ProjectNavigationProvider>
        </I18nProvider>
      ),
    },
  );
});

it.each([
  { label: "Apply", expanded: false },
  { label: "Discard", expanded: false },
  { label: "Apply", expanded: true },
  { label: "Discard", expanded: true },
])("the strip's new document dispatches whole $label (expanded: $expanded)", async ({
  label,
  expanded,
}) => {
  const file = { ...draft("new-scene", [pacing]), isNewDocument: true };
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [file] });
  fixture.network.getDraftPreview.mockResolvedValue({
    ...preview,
    draftId: file.draftId,
    isNewDocument: true,
    operations: [op("1", pacing), op("2", pacing)],
  });
  const request = label === "Apply" ? fixture.network.applyDraft : fixture.network.discardDraft;
  request.mockResolvedValue({
    status: label === "Apply" ? "applied" : "discarded",
    draftId: file.draftId,
  } as never);
  await fixture.render(
    async () => {
      await settleReact(() => expect(text()).toContain("1 change"));
      if (expanded) {
        await act(async () =>
          document.querySelector<HTMLButtonElement>('[aria-label="Expand changes"]')?.click(),
        );
        await settleReact(() =>
          expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(1),
        );
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              `[data-review-change-row] button[aria-label="${label}"]`,
            )
            ?.click(),
        );
      } else await click(label);
      expect(request).toHaveBeenCalledWith("project-a", "work-a", "new-scene", {
        draftId: file.draftId,
      });
      expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    },
    {
      chatSurface: <Strip />,
      host: (children) => (
        <I18nProvider i18n={i18n}>
          <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
            <TooltipProvider>{children}</TooltipProvider>
          </ProjectNavigationProvider>
        </I18nProvider>
      ),
    },
  );
});
