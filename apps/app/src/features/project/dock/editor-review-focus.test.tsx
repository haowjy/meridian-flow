// @vitest-environment jsdom
/** A review opened on given operations focuses their change once, after the requested review paints. */

import { act, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
} from "@/features/draft-review/DraftReviewProvider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { EditorReviewAddressOwner } from "./EditorReviewAddressOwner";
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

function createLaunchFixture(start: Partial<Model> = {}, delayedAdmission = false) {
  const focusReviewChange = vi.fn();
  const enterInlineReview = vi.fn();
  const route = vi.fn().mockImplementation(async () => {
    fixture.nameDraftInAddress();
    return { kind: "applied" };
  });
  const fixture = {
    focusReviewChange,
    enterInlineReview,
    route,
    openReview: null as ((target: AiDraftLaunchTarget) => Promise<void>) | null,
    update: (_next: Partial<Model>) => {},
    mountEditor: () => {},
    nameDraftInAddress: () => {},
  };
  function CommandCapture() {
    const command = useOpenEditorReview();
    useEffect(() => {
      fixture.openReview = command;
    }, [command]);
    return null;
  }
  function Harness() {
    const [state, setState] = useState<Model>({
      inline: null,
      preview: null,
      changes: [],
      ...start,
    });
    const [mounted, setMounted] = useState(!delayedAdmission);
    const [addressed, setAddressed] = useState(false);
    model.current = state;
    fixture.update = (next) => setState((previous) => ({ ...previous, ...next }));
    fixture.mountEditor = () => setMounted(true);
    fixture.nameDraftInAddress = () => setAddressed(true);
    const files = [
      {
        documentId: target.documentId,
        documentName: "One",
        contextPath: target.contextPath,
        draft: { draftId: target.draftId },
      },
    ];
    const review = {
      controller: {
        workId: target.workId,
        inlineReview: state.inline,
        enterInlineReview,
        exitInlineReview: vi.fn(),
        focusReviewChange,
      },
      files,
      drafts: { status: "ready" },
      fileForDocument: (id: string | null | undefined) =>
        files.find((group) => group.documentId === id) ?? null,
      activeEditorDocumentId: mounted ? target.documentId : null,
    } as unknown as DraftReviewContextValue;
    return (
      <EditorReviewHandoffProvider projectId="project-1" openContextRoute={route}>
        <CommandCapture />
        {delayedAdmission && (
          <EditorReviewAddressOwner
            review={review}
            requestedDraftId={addressed ? target.draftId : undefined}
            activeScreen="context"
            activeScheme="manuscript"
            activePath={target.contextPath}
            activeDocumentId={target.documentId}
            onSetDraftId={vi.fn()}
          />
        )}
        <DraftReviewBoundary value={review}>
          <EditorReviewIntentClaimant editorWorkId={target.workId} activeScheme="manuscript" />
        </DraftReviewBoundary>
      </EditorReviewHandoffProvider>
    );
  }
  return {
    ...fixture,
    Harness,
    get controls() {
      return fixture;
    },
  };
}

async function launch(
  launched: AiDraftLaunchTarget,
  start: Partial<Model>,
  run: (fixture: ReturnType<typeof createLaunchFixture>["controls"]) => Promise<void>,
) {
  const fixture = createLaunchFixture(start);
  await withReactRoot(<fixture.Harness />, async () => {
    await act(async () => {
      await fixture.controls.openReview?.(launched);
    });
    await run(fixture.controls);
  });
}

const requested = { documentId: target.documentId, draftId: target.draftId };

describe("opening a review on given operations", () => {
  it("focuses the change once the requested review has painted and loaded", async () => {
    await launch(target, {}, async ({ enterInlineReview, focusReviewChange, update }) => {
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
      async ({ focusReviewChange }) =>
        expect(focusReviewChange).toHaveBeenCalledExactlyOnceWith(requested, changes[1], {
          scroll: true,
        }),
    );
  });

  it("opens at the top when none of the operations is in the review any more", async () => {
    await launch(
      { ...target, focusOperationIds: ["op-gone"] },
      { inline: { ...requested, shown: true }, preview: { status: "active" }, changes },
      async ({ enterInlineReview, focusReviewChange, update }) => {
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
      async ({ focusReviewChange, update }) => {
        expect(focusReviewChange).not.toHaveBeenCalled();
        await act(async () => update?.({ inline: { ...requested, shown: true } }));
        expect(focusReviewChange).toHaveBeenCalledExactlyOnceWith(requested, changes[1], {
          scroll: true,
        });
      },
    );
  });

  it("drops the request when the writer leaves the review before it paints", async () => {
    await launch(target, {}, async ({ focusReviewChange, update }) => {
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
      async ({ focusReviewChange }) => expect(focusReviewChange).not.toHaveBeenCalled(),
    );
  });
});

/**
 * A launch from another screen (the Work page's change row): the route settles
 * while the Editor has not mounted the document yet, and the address now names
 * the draft. The address owner must wait for the launch's claim, not restore the
 * review itself as a second launch that names no change.
 */
describe("a launch whose route settles before the Editor mounts the document", () => {
  it("focuses the change it named once the Editor has the document", async () => {
    const fixture = createLaunchFixture({}, true);
    const { enterInlineReview, focusReviewChange, route } = fixture;
    enterInlineReview.mockImplementation((documentId: string, draftId: string) =>
      fixture.controls.update({ inline: { documentId, draftId, shown: false } }),
    );
    await withReactRoot(<fixture.Harness />, async () => {
      await act(async () => {
        await fixture.controls.openReview?.(target);
      });
      // The route settled and the address names the draft; the launch is the only one.
      expect(route).toHaveBeenCalledOnce();
      await act(async () => fixture.controls.mountEditor());
      expect(enterInlineReview).toHaveBeenCalledWith("doc-1", "draft-1");
      await act(async () =>
        fixture.controls.update({
          inline: { ...requested, shown: true },
          preview: { status: "active" },
          changes,
        }),
      );
      expect(focusReviewChange).toHaveBeenCalledExactlyOnceWith(requested, changes[1], {
        scroll: true,
      });
    });
  });
});
