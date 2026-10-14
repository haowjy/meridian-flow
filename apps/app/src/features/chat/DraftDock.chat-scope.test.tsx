// @vitest-environment jsdom
/** S-chat: shared-class batch authority, queued disappearance and independently refused recovery. */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, type ReactNode } from "react";
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
import { WorkChanges } from "@/features/project/work/WorkChanges";
import {
  createReviewScopeFixture,
  listed,
  operation,
  preview,
  work,
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
  replyStreaming = false;
  fixture.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const pacing = { threadId: "thread-a", title: "Pacing pass" };
const draft = (id: string, actors: (typeof pacing)[]) => ({
  ...listed,
  documentId: id,
  itemKey: `draft-${id}`,
  documentName: id,
  contextLocation: { scheme: "manuscript" as const, path: `/${id}.md` },
  actorThreads: actors,
});
const op = (id: string, actor: typeof pacing | null, classId = `class-${id}`) => ({
  ...operation(id),
  closureClassId: classId,
  admissionToken: classId,
  ...(actor
    ? { actorThreadId: actor.threadId, actorThreadTitle: actor.title }
    : { kind: "writer" as const }),
});
function DesktopEnvironment({ children }: { children: ReactNode }) {
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
  return children;
}
let replyStreaming = false;
function Strip() {
  return <DraftDock dock={useDraftDock({ threadId: "thread-a", generating: replyStreaming })} />;
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
  { label: "Apply", expanded: false, streaming: true },
  { label: "Discard", expanded: true, streaming: false },
])("the strip's new document dispatches whole $label (expanded: $expanded, reply streaming: $streaming)", async ({
  label,
  expanded,
  streaming,
}) => {
  replyStreaming = streaming;
  const file = { ...draft("new-scene", [pacing]), isNew: true, wholeItem: true };
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [file] });
  fixture.network.getDraftPreview.mockResolvedValue({
    ...preview,
    itemKey: file.itemKey,
    item: { ...file, isNew: true, wholeItem: true },
    operations: [op("1", pacing), op("2", pacing)],
  });
  const request = label === "Apply" ? fixture.network.applyDraft : fixture.network.discardDraft;
  request.mockResolvedValue({
    status: label === "Apply" ? "applied" : "discarded",
    itemKey: file.itemKey,
  } as never);
  await fixture.render(
    async () => {
      await settleReact(() => expect(text()).toContain("1 change"));
      expect(
        [...document.querySelectorAll("[data-draft-dock] button")].some(
          (button) => button.textContent === "Review",
        ),
      ).toBe(false);
      await click("new-scene");
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          workId: "work-a",
          documentId: "new-scene",
          itemKey: file.itemKey,
        }),
      );
      expect(document.querySelector('[aria-label="Expand changes"]')).not.toBeNull();
      if (expanded) {
        await act(async () =>
          document.querySelector<HTMLButtonElement>('[aria-label="Expand changes"]')?.click(),
        );
        await settleReact(() =>
          expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(0),
        );
        expect(
          [...document.querySelectorAll("[data-draft-dock-file] button")].some(
            (button) => button.textContent === "new-scene",
          ),
        ).toBe(true);
        await click(label);
      } else await click(label);
      expect(request).toHaveBeenCalledWith(
        "project-a",
        "work-a",
        "new-scene",
        expect.objectContaining({
          draftId: listed.draftId,
          itemKey: file.itemKey,
          commandId: expect.any(String),
        }),
      );
      expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    },
    {
      chatSurface: <Strip />,
      host: (children) => (
        <DesktopEnvironment>
          <I18nProvider i18n={i18n}>
            <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
              <TooltipProvider>{children}</TooltipProvider>
            </ProjectNavigationProvider>
          </I18nProvider>
        </DesktopEnvironment>
      ),
    },
  );
});

it.each([
  {
    isNew: false,
    code: "review-failed" as const,
    message: "Couldn't open this draft. Try again.",
  },
  {
    isNew: false,
    code: "apply-offline" as const,
    message: "Couldn't apply. Check your connection and try again.",
  },
  {
    isNew: true,
    wholeItem: true,
    code: "apply-offline" as const,
    message: "Couldn't apply. Check your connection and try again.",
  },
])("gives a single file's $code one owner after expansion (new: $isNew)", async ({
  code,
  message,
  isNew,
}) => {
  const file = { ...draft("chapter-12", [pacing]), isNew };
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [file] });
  fixture.network.getDraftPreview.mockResolvedValue({
    ...preview,
    itemKey: file.itemKey,
    item: { ...file, isNew, wholeItem: isNew },
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
          itemKey: file.itemKey,
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
      expect(document.querySelectorAll("[data-review-change-row]")).toHaveLength(isNew ? 0 : 1);
      if (code === "review-failed") {
        await click("chapter-12");
        expect(navigate).toHaveBeenCalledWith(
          expect.objectContaining({ documentId: "chapter-12" }),
        );
        expect(document.querySelector('[aria-label="Collapse changes"]')).not.toBeNull();
      }
      if (!isNew) {
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
        <DesktopEnvironment>
          <I18nProvider i18n={i18n}>
            <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
              <TooltipProvider>{children}</TooltipProvider>
            </ProjectNavigationProvider>
          </I18nProvider>
        </DesktopEnvironment>
      ),
    },
  );
});

it("all accepted batch targets disappear at the click and a refused target restores independently", async () => {
  const files = [draft("chapter-a", [pacing]), draft("chapter-b", [pacing])];
  fixture.network.listWorkDrafts.mockResolvedValue({ items: files });
  fixture.network.getDraftPreview.mockImplementation(async (_project, _work, documentId) => ({
    ...preview,
    itemKey: `draft-${documentId}`,
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
        confirm({ status: "discarded", itemKey: files[0]?.itemKey, itemClosed: false });
        refuse(new HttpResponseError("Refused", 500, null));
      });
      await settleReact(() => expect(text()).toContain("1 change"));
      expect(text()).toContain("chapter-b");
      expect(text()).not.toContain("chapter-a");
    },
    {
      chatSurface: <Strip />,
      host: (children) => (
        <DesktopEnvironment>
          <I18nProvider i18n={i18n}>
            <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
              <TooltipProvider>{children}</TooltipProvider>
            </ProjectNavigationProvider>
          </I18nProvider>
        </DesktopEnvironment>
      ),
    },
  );
});

it("new documents have one review door and whole-draft commands in chat and Work rows", async () => {
  const files = ["chapter-a", "chapter-b"].map((id) => ({
    ...draft(id, [pacing]),
    isNew: true,
    wholeItem: true,
  }));
  fixture.network.listWorkDrafts.mockResolvedValue({ items: files });
  fixture.network.getDraftPreview.mockImplementation(async (_p, _w, documentId) => ({
    ...preview,
    itemKey: `draft-${documentId}`,
    documentName: documentId,
    item: { ...listed, documentId, itemKey: `draft-${documentId}`, isNew: true, wholeItem: true },
    operations: [op(documentId, pacing)],
  }));
  fixture.network.applyDraft.mockReturnValue(new Promise(() => {}));
  await fixture.render(
    async () => {
      await settleReact(() => expect(text()).toContain("2 changes"));
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label="Expand changes"]')?.click(),
      );
      await settleReact(() =>
        expect(strip()?.querySelectorAll("[data-review-change-row]")).toHaveLength(2),
      );
      const workRows = document.querySelector("[data-work-whole-test]");
      for (const name of ["chapter-a", "chapter-b"]) {
        await act(async () =>
          workRows?.querySelector<HTMLButtonElement>(`[aria-label="Changes in ${name}"]`)?.click(),
        );
      }
      await settleReact(() =>
        expect(workRows?.querySelectorAll("[data-review-change-row]")).toHaveLength(2),
      );
      expect(strip()?.querySelectorAll("[data-draft-dock-file] button")).toHaveLength(6);
      for (const name of ["chapter-a", "chapter-b"])
        expect(workRows?.querySelector(`[aria-label="Changes in ${name}"]`)).toBeNull();
      for (const surface of [strip(), workRows]) {
        for (const name of ["chapter-a", "chapter-b"]) {
          expect(
            [...(surface?.querySelectorAll("button") ?? [])].filter(
              (button) => button.textContent === name,
            ),
          ).toHaveLength(1);
        }
        expect(surface?.querySelector("[data-review-change-row] [data-tone]")).toBeNull();
      }
      await act(async () =>
        workRows
          ?.querySelector<HTMLButtonElement>('[data-review-change-row] [aria-label="Apply"]')
          ?.click(),
      );
      expect(fixture.network.applyDraft).toHaveBeenCalledWith(
        "project-a",
        "work-a",
        "chapter-a",
        expect.objectContaining({
          draftId: listed.draftId,
          itemKey: "draft-chapter-a",
          commandId: expect.any(String),
        }),
      );
      expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    },
    {
      chatSurface: <Strip />,
      surface: (
        <section data-work-whole-test>
          <WorkChanges projectId="project-a" work={work} matchesSearch={() => true} />
        </section>
      ),
      host: (children) => (
        <DesktopEnvironment>
          <I18nProvider i18n={i18n}>
            <ProjectNavigationProvider openContextRoute={navigate} openWork={navigate}>
              <TooltipProvider>{children}</TooltipProvider>
            </ProjectNavigationProvider>
          </I18nProvider>
        </DesktopEnvironment>
      ),
    },
  );
});
