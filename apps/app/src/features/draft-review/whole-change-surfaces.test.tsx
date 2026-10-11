// @vitest-environment jsdom
/** Whole-draft disposition from the Work row, document list and focused bar. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as handoff from "@/features/project/dock/editor-review-handoff";
import { WorkChangeFile } from "@/features/project/work/WorkChangeFile";
import {
  createReviewScopeFixture,
  listed,
  operation,
  preview,
} from "@/test-support/draft-review-scope";
import { settleReact } from "@/test-support/react-dom-harness";
import { DocumentChangeRows } from "./DocumentChangeRows";
import { usePresentedDraftReview } from "./DraftReviewProvider";
import { ReviewChangeBar } from "./ReviewChangeBar";
import { useDraftChanges } from "./useDraftChanges";
import { useBoundWorkDraftCommands } from "./useWorkDraftCommands";

let fixture: ReturnType<typeof createReviewScopeFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  fixture = createReviewScopeFixture();
  vi.spyOn(handoff, "useOpenEditorReview").mockReturnValue(vi.fn().mockResolvedValue(undefined));
  fixture.network.listWorkDrafts.mockResolvedValue({
    drafts: [{ ...listed, isNewDocument: true }],
  });
  fixture.network.getDraftPreview.mockResolvedValue({
    ...preview,
    isNewDocument: true,
    operations: [operation("1"), operation("2")],
  });
});
afterEach(() => {
  fixture.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Surface({ kind }: { kind: "work" | "list" | "bar" }) {
  const commands = useBoundWorkDraftCommands();
  const file = usePresentedDraftReview().files[0];
  const draft = {
    projectId: "project-a",
    workId: "work-a",
    documentId: "document-a",
    draftId: "draft-a",
  };
  const view = useDraftChanges(draft, { controller: commands, enabled: kind !== "work" });
  if (kind === "work")
    return file ? (
      <WorkChangeFile
        projectId="project-a"
        workId="work-a"
        file={file}
        controller={commands}
        touch={false}
      />
    ) : null;
  const change = view.items[0]?.change;
  if (kind === "bar")
    return change ? (
      <ReviewChangeBar
        change={change}
        disabled={view.locked}
        failure={null}
        onApply={() => void view.apply(change)}
        onDiscard={() => void view.discard(change)}
      />
    ) : null;
  return <DocumentChangeRows view={view} onSelect={() => {}} />;
}

it.each([
  "work",
  "list",
  "bar",
] as const)("%s routes its one change to whole Apply and Discard", async (kind) => {
  for (const mode of ["apply", "discard"] as const) {
    const request = mode === "apply" ? fixture.network.applyDraft : fixture.network.discardDraft;
    // Hold at the process boundary: verify admission and optimistic disappearance.
    if (mode === "apply") fixture.network.applyDraft.mockReturnValue(new Promise(() => {}));
    else fixture.network.discardDraft.mockReturnValue(new Promise(() => {}));
    await fixture.render(
      async () => {
        if (kind === "work") {
          await settleReact(() =>
            expect(document.querySelector('[aria-label="Changes in Chapter 12"]')).not.toBeNull(),
          );
          await act(async () =>
            document
              .querySelector<HTMLButtonElement>('[aria-label="Changes in Chapter 12"]')
              ?.click(),
          );
        }
        const button = () =>
          [...document.querySelectorAll<HTMLButtonElement>("button")].find(
            (b) =>
              b.getAttribute("aria-label") === (mode === "apply" ? "Apply" : "Discard") ||
              b.textContent === (mode === "apply" ? "Apply" : "Discard"),
          );
        await settleReact(() => expect(button()).toBeDefined());
        await act(async () => button()?.click());
        expect(request).toHaveBeenCalledWith("project-a", "work-a", "document-a", {
          draftId: "draft-a",
        });
        expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
      },
      {
        chatSurface: <Surface kind={kind} />,
        host: (children) => (
          <I18nProvider i18n={i18n}>
            <TooltipProvider>{children}</TooltipProvider>
          </I18nProvider>
        ),
      },
    );
    resetDraftCommandRecords();
  }
});
