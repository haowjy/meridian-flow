// @vitest-environment jsdom
/** S-chat: shared-class batch authority, queued disappearance and independently refused recovery. */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import * as projectsApi from "@/client/api/projects-api";
import {
  failDraftCommand,
  failDraftReviewLaunch,
  resetDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import {
  createReviewScopeFixture,
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

it.each([
  { label: "Apply", expanded: false },
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
        expect(
          [...document.querySelectorAll("[data-draft-dock-file] button")].some(
            (button) => button.textContent === "new-scene",
          ),
        ).toBe(false);
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

it.each([
  {
    isNewDocument: false,
    code: "review-failed" as const,
    message: "Couldn't open this draft. Try again.",
  },
  {
    isNewDocument: false,
    code: "apply-offline" as const,
    message: "Couldn't apply. Check your connection and try again.",
  },
  {
    isNewDocument: true,
    code: "apply-offline" as const,
    message: "Couldn't apply. Check your connection and try again.",
  },
])("gives a single file's $code one owner after expansion (new: $isNewDocument)", async ({
  code,
  message,
  isNewDocument,
}) => {
  const file = { ...draft("chapter-12", [pacing]), isNewDocument };
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [file] });
  fixture.network.getDraftPreview.mockResolvedValue({
    ...preview,
    draftId: file.draftId,
    isNewDocument,
    operations: [op("1", pacing)],
  });
  await fixture.render(
    async () => {
      await settleReact(() => expect(text()).toContain("1 change"));
      await act(async () => {
        const ref = {
          projectId: "project-a",
          workId: "work-a",
          documentId: "chapter-12",
          draftId: file.draftId,
        };
        if (code === "review-failed") failDraftReviewLaunch(ref);
        else failDraftCommand(ref, { code });
      });
      await settleReact(() =>
        expect(document.querySelector('[aria-label="Collapse changes"]')).not.toBeNull(),
      );
      expect(
        [...document.querySelectorAll('[role="alert"],[role="status"]')].filter(
          (node) => node.textContent === message,
        ),
      ).toHaveLength(1);
      expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(1);
      if (!isNewDocument) {
        expect(
          document
            .querySelector("[data-draft-dock-strip-error] span[title]")
            ?.getAttribute("title"),
        ).toBe(message);
      }
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

it("all accepted batch targets disappear at the click and a refused target restores independently", async () => {
  const files = [draft("chapter-a", [pacing]), draft("chapter-b", [pacing])];
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: files });
  fixture.network.getDraftPreview.mockImplementation(async (_project, _work, documentId) => ({
    ...preview,
    draftId: `draft-${documentId}`,
    operations: [op(documentId, pacing)],
  }));
  let confirm!: (value: unknown) => void;
  let refuse!: (error: unknown) => void;
  const first = new Promise((resolve) => {
    confirm = resolve;
  });
  const second = new Promise((_resolve, reject) => {
    refuse = reject;
  });
  fixture.network.discardDraft.mockImplementation(
    (_project, _work, documentId) => (documentId === "chapter-a" ? first : second) as never,
  );
  await fixture.render(
    async () => {
      await settleReact(() => expect(text()).toContain("2 changes"));
      await click("Discard");
      await click("Discard");
      expect(strip()).toBeNull();
      expect(fixture.network.discardDraft).toHaveBeenCalledTimes(2);
      await act(async () => {
        confirm({ status: "discarded", draftId: files[0]?.draftId, draftClosed: false });
        refuse(new HttpResponseError("Refused", 500, null));
      });
      await settleReact(() => expect(text()).toContain("1 change"));
      expect(text()).toContain("chapter-b");
      expect(text()).not.toContain("chapter-a");
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
