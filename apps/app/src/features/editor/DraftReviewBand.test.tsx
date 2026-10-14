// @vitest-environment jsdom
/**
 * The review band over a real review editor and the real provider. It protects the writer's flows:
 * stepping scrolls to the change, Apply leaves the screen at the click and returns with its reason, and
 * Discard draft is an editor edit that Ctrl+Z brings back, with "No changes left" a function of the text.
 */

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { act, useMemo } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { HttpResponseError } from "@/client/api/http-client";
import * as projectsApi from "@/client/api/projects-api";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { ProjectNavigationProvider } from "@/features/project/routing/ProjectNavigationContext";
import {
  createReviewScopeFixture,
  deferredReviewAnswer,
  listed,
  meta,
} from "@/test-support/draft-review-scope";
import {
  createReviewEditor,
  destroyReviewEditors,
  seedReviewBase,
} from "@/test-support/inline-review-editor";
import { settleReact } from "@/test-support/react-dom-harness";
import { DraftReviewBand } from "./DraftReviewBand";
import { useInlineReviewFocus } from "./useInlineReviewFocus";
import { useInlineReviewSync } from "./useInlineReviewSync";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const scrolled: Element[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  i18n.loadAndActivate({ locale: "en", messages: {} });
  fixture = createReviewScopeFixture();
  vi.spyOn(projectsApi, "listProjectWorks").mockReturnValue(new Promise(() => {}));
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  fixture.dispose();
  destroyReviewEditors();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The room as the app mounts it: the editor, its sync state and the projection published to the controller. */
const syncedSession = (document: Y.Doc) =>
  ({
    document,
    getSnapshot: () => ({ status: "synced" }),
    subscribe: () => () => {},
    whenSynced: () => Promise.resolve(),
    hasUnacknowledgedEdits: () => false,
  }) as never;
/** Mounted only once the review is open, as the editor is: a model announced before then has no review to join. */
function Runtime(props: { editor: Editor; doc: Y.Doc }) {
  return useDraftReview().controller.inlineReview ? <OpenRuntime {...props} /> : null;
}
function OpenRuntime({ editor, doc }: { editor: Editor; doc: Y.Doc }) {
  const { controller } = useDraftReview();
  const session = useMemo(() => syncedSession(doc), [doc]);
  useInlineReviewSync({
    editor,
    session,
    documentId: "document-a",
    itemKey: "draft-a",
    onInlineModelAvailable: controller.inlineReviewModelAvailable,
  });
  useInlineReviewFocus({ editor, documentId: "document-a", itemKey: "draft-a" });
  controller.setInlineReviewShown("document-a", "draft-a", true);
  return null;
}

const draft = ["Alpha green.", "Filler one.", "Filler two.", "Filler three.", "Omega green."];
const base = ["Alpha red.", "Filler one.", "Filler two.", "Filler three.", "Omega red."];
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-review-change-row]")];
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const text = (editor: Editor) => {
  const out: string[] = [];
  editor.state.doc.forEach((node) => {
    out.push(node.textContent);
  });
  return out;
};
const undo = (editor: Editor) => yUndoPluginKey.getState(editor.state)?.undoManager.undo();
const host = (children: React.ReactNode) => (
  <I18nProvider i18n={i18n}>
    <TooltipProvider>
      <ProjectNavigationProvider openContextRoute={vi.fn()} openWork={vi.fn()}>
        {children}
      </ProjectNavigationProvider>
    </TooltipProvider>
  </I18nProvider>
);

async function review(
  run: (
    editor: Editor,
    doc: Y.Doc,
    probe: Parameters<Parameters<typeof fixture.render>[0]>[0],
  ) => Promise<void>,
) {
  fixture.network.listWorkDrafts.mockResolvedValue({ items: [listed] });
  fixture.network.getDraftMeta.mockResolvedValue(meta);
  const { editor, doc } = createReviewEditor(draft);
  seedReviewBase(doc, base);
  await fixture.render(
    async (probe) => {
      // The harness renders into its own window; the editor's scroll reads motion preference from it.
      window.matchMedia = (() => ({ matches: false })) as never;
      await settleReact(() => expect(probe().presented.files).toHaveLength(1));
      await act(async () =>
        probe().presented.controller.enterInlineReview("document-a", "draft-a"),
      );
      await settleReact(() => expect(probe().header.view.items).toHaveLength(2));
      await run(editor, doc, probe);
    },
    {
      surface: (
        <>
          <DraftReviewBand documentId="document-a" itemKey="draft-a" onOpenDraft={vi.fn()} />
          <Runtime editor={editor} doc={doc} />
        </>
      ),
      host,
    },
  );
}

it("steps through the changes, bringing each into view, with marks hidden and not restoring them", async () => {
  await review(async (editor, _doc, probe) => {
    await act(async () => probe().presented.controller.setMarksVisible(false));
    for (const [label, paragraph] of [
      ["Next change", "Alpha green."],
      ["Next change", "Omega green."],
      ["Previous change", "Alpha green."],
    ] as const) {
      await act(async () => button(label)?.click());
      const target = scrolled.at(-1);
      expect(target?.textContent).toBe(paragraph);
      expect(editor.view.dom.contains(target ?? null)).toBe(true);
      expect(probe().presented.controller.marksVisible).toBe(false);
    }
  });
});

it("Apply takes the change off the screen at the click, sends its id and snapshot, never claims 'No changes left' while one is out, and restores a refused change with the reason", async () => {
  const answer = deferredReviewAnswer<never>();
  const second = deferredReviewAnswer<never>();
  fixture.network.applyDraftChanges.mockReturnValueOnce(answer.promise);
  fixture.network.applyDraftChanges.mockReturnValueOnce(second.promise);
  await review(async (_editor, _doc, probe) => {
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          "[data-draft-review-controls] [data-slot=popover-trigger]",
        )
        ?.click(),
    );
    expect(rows()).toHaveLength(2);
    const first = rows()[0].dataset.reviewChangeRow as string;
    await act(async () =>
      rows()[0].querySelector<HTMLButtonElement>('[aria-label="Apply"]')?.click(),
    );
    expect(rows()).toHaveLength(1);
    await settleReact(() => expect(fixture.network.applyDraftChanges).toHaveBeenCalledOnce());
    expect(fixture.network.applyDraftChanges.mock.calls[0].slice(0, 3)).toEqual([
      "project-a",
      "work-a",
      "document-a",
    ]);
    expect(fixture.network.applyDraftChanges.mock.calls[0][3]).toMatchObject({
      itemKey: "draft-a",
      changeIds: [first],
      snapshot: expect.stringMatching(/^[A-Za-z0-9+/=]+$/),
    });
    // The last change goes too, and the draft is not finished while either answer is outstanding.
    await act(async () =>
      rows()[0].querySelector<HTMLButtonElement>('[aria-label="Apply"]')?.click(),
    );
    await settleReact(() => expect(fixture.network.applyDraftChanges).toHaveBeenCalledTimes(2));
    expect(rows()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("No changes left");
    await act(async () =>
      second.resolve({
        status: "applied",
        itemKey: "draft-a",
        itemClosed: false,
        overrode: [],
      } as never),
    );
    expect(document.body.textContent).not.toContain("No changes left");
    // A refused request puts the change back with the error on it.
    await act(async () => answer.reject(new HttpResponseError("boom", 500, undefined)));
    // The list closed when nothing was left to show; the returned change is there when it is opened again.
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          "[data-draft-review-controls] [data-slot=popover-trigger]",
        )
        ?.click(),
    );
    await settleReact(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].textContent).toContain("Couldn't apply this change. Try again.");
    expect(document.body.textContent).not.toContain("No changes left");
    expect(probe().presented.controller.isDisposing).toBe(false);
  });
});

it("Discard draft is an editor edit: no request, 'No changes left', and Ctrl+Z brings the changes back", async () => {
  await review(async (editor, _doc, probe) => {
    await act(async () => button("Discard draft")?.click());
    expect(text(editor)).toEqual(base);
    await settleReact(() => expect(document.body.textContent).toContain("No changes left"));
    expect(fixture.network.applyDraft).not.toHaveBeenCalled();
    expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    expect(fixture.network.discardDraft).not.toHaveBeenCalled();
    expect(button("Apply draft")).toBeNull();

    await act(async () => undo(editor));
    expect(text(editor)).toEqual(draft);
    await settleReact(() => expect(probe().header.view.items).toHaveLength(2));
    expect(document.body.textContent).not.toContain("No changes left");
  });
});

it("Apply draft sent at once after typing carries the words just typed, not the frame the debounce had reached", async () => {
  fixture.network.applyDraft.mockReturnValue(new Promise(() => {}));
  await review(async (editor, doc) => {
    await settleReact(() => expect(button("Apply draft")?.disabled).toBe(false));
    const shown = Y.snapshot(doc);
    await act(async () => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, " A heron watched.");
    });
    // No timers advance: the runtime's last frame still shows the text before the typing.
    await act(async () => button("Apply draft")?.click());
    await settleReact(() => expect(fixture.network.applyDraft).toHaveBeenCalledOnce());
    const sent = fixture.network.applyDraft.mock.calls[0][3] as { snapshot: string };
    const bytes = Uint8Array.from(atob(sent.snapshot), (char) => char.charCodeAt(0));
    const applied = Y.decodeSnapshot(bytes);
    expect(Y.equalSnapshots(applied, Y.snapshot(doc))).toBe(true);
    expect(Y.equalSnapshots(applied, shown)).toBe(false);
  });
});
