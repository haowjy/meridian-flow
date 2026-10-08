// @vitest-environment jsdom
/** A review opened on given operations focuses their change once, after the requested review paints. */

import { act, useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
} from "@/features/draft-review/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { AiDraftLaunchTarget } from "./editor-review-handoff";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
  useOpenEditorReview,
} from "./editor-review-handoff";

type Open = { documentId: string; draftId: string; shown: boolean } | null;
type Model = {
  inline: Open;
  preview: { status: "active" | "gone" } | null;
  changes: { classId: string; operationIds: string[]; anchorOperationId: string }[];
};

// The preview read is the one boundary that needs a query client; the claimant
// is what these tests drive.
const model = vi.hoisted(() => ({ current: null as unknown as Model }));
vi.mock("@/features/draft-review/useReviewChanges", () => ({
  useOpenReviewChanges: () => ({
    preview: model.current.preview,
    active: model.current.preview?.status === "active" ? model.current.preview : null,
    changes: model.current.changes,
  }),
}));

const target: AiDraftLaunchTarget = {
  workId: "work-1",
  documentId: "doc-1",
  draftId: "draft-1",
  contextPath: "chapters/one.md",
  focusOperationIds: ["op-2"],
};
const other = { documentId: "doc-0", draftId: "draft-0" };
const changes = [
  { classId: "c1", operationIds: ["op-1"], anchorOperationId: "op-1" },
  { classId: "c2", operationIds: ["op-2", "op-3"], anchorOperationId: "op-2" },
];

let openReview: ((target: AiDraftLaunchTarget) => Promise<void>) | null = null;
let update: ((next: Partial<Model>) => void) | null = null;
const focusReviewChange = vi.fn();
const enterInlineReview = vi.fn();

function CommandCapture() {
  const command = useOpenEditorReview();
  useEffect(() => {
    openReview = command;
  }, [command]);
  return null;
}

function Harness() {
  const [state, setState] = useState<Model>(model.current);
  model.current = state;
  useEffect(() => {
    update = (next) => setState((previous) => ({ ...previous, ...next }));
  }, []);
  const groups = [{ documentId: target.documentId, draft: { draftId: target.draftId } }];
  const review = {
    controller: {
      workId: target.workId,
      inlineReview: state.inline,
      enterInlineReview,
      focusReviewChange,
    },
    groups,
    groupForDocument: (id: string | null | undefined) =>
      groups.find((group) => group.documentId === id) ?? null,
    activeEditorDocumentId: target.documentId,
  } as unknown as DraftReviewContextValue;
  return (
    <EditorReviewHandoffProvider
      projectId="project-1"
      openContextRoute={vi.fn().mockResolvedValue({ kind: "applied" })}
    >
      <CommandCapture />
      <DraftReviewBoundary value={review}>
        <EditorReviewIntentClaimant editorWorkId={target.workId} activeScheme="manuscript" />
      </DraftReviewBoundary>
    </EditorReviewHandoffProvider>
  );
}

async function launch(
  launched: AiDraftLaunchTarget,
  start: Partial<Model>,
  run: () => Promise<void>,
) {
  model.current = { inline: null, preview: null, changes: [], ...start };
  await withReactRoot(<Harness />, async () => {
    await act(async () => {
      await openReview?.(launched);
    });
    await run();
  });
}

const requested = { documentId: target.documentId, draftId: target.draftId };

describe("opening a review on given operations", () => {
  beforeEach(() => {
    focusReviewChange.mockClear();
    enterInlineReview.mockClear();
    openReview = null;
    update = null;
  });

  it("focuses the change once the requested review has painted and loaded", async () => {
    await launch(target, {}, async () => {
      expect(enterInlineReview).toHaveBeenCalledWith("doc-1", "draft-1");
      // Entered but not painted, then painted but not loaded: nothing yet.
      await act(async () => update?.({ inline: { ...requested, shown: false } }));
      await act(async () => update?.({ inline: { ...requested, shown: true } }));
      expect(focusReviewChange).not.toHaveBeenCalled();
      await act(async () => update?.({ preview: { status: "active" }, changes }));
      expect(focusReviewChange).toHaveBeenCalledOnce();
      expect(focusReviewChange).toHaveBeenCalledWith(requested, changes[1], { scroll: true });
      // Applied once: later previews do not pull the writer back.
      await act(async () => update?.({ changes: [...changes] }));
      expect(focusReviewChange).toHaveBeenCalledOnce();
    });
  });

  it("focuses at once when the requested review is already painted and loaded", async () => {
    await launch(
      target,
      { inline: { ...requested, shown: true }, preview: { status: "active" }, changes },
      async () =>
        expect(focusReviewChange).toHaveBeenCalledExactlyOnceWith(requested, changes[1], {
          scroll: true,
        }),
    );
  });

  it("opens at the top when none of the operations is in the review any more", async () => {
    await launch(
      { ...target, focusOperationIds: ["op-gone"] },
      { inline: { ...requested, shown: true }, preview: { status: "active" }, changes },
      async () => {
        expect(enterInlineReview).toHaveBeenCalledOnce();
        expect(focusReviewChange).not.toHaveBeenCalled();
        await act(async () => update?.({ changes: [...changes] }));
        expect(focusReviewChange).not.toHaveBeenCalled();
      },
    );
  });

  it("does not focus a different review that paints first", async () => {
    await launch(
      target,
      { inline: { ...other, shown: true }, preview: { status: "active" }, changes },
      async () => {
        expect(focusReviewChange).not.toHaveBeenCalled();
        await act(async () => update?.({ inline: { ...requested, shown: true } }));
        expect(focusReviewChange).toHaveBeenCalledExactlyOnceWith(requested, changes[1], {
          scroll: true,
        });
      },
    );
  });

  it("drops the request when the writer leaves the review before it paints", async () => {
    await launch(target, {}, async () => {
      await act(async () => update?.({ inline: { ...requested, shown: false } }));
      await act(async () => update?.({ inline: { ...other, shown: true } }));
      await act(async () =>
        update?.({ inline: { ...requested, shown: true }, preview: { status: "active" }, changes }),
      );
      expect(focusReviewChange).not.toHaveBeenCalled();
    });
  });

  it("does not focus a launch that names no operation", async () => {
    await launch(
      { ...target, focusOperationIds: undefined },
      { inline: { ...requested, shown: true }, preview: { status: "active" }, changes },
      async () => expect(focusReviewChange).not.toHaveBeenCalled(),
    );
  });
});
