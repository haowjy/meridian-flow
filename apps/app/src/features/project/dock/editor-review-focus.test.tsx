// @vitest-environment jsdom
/** A review opened on given changes focuses the first still listed once, after the requested review paints. */

import { act, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
} from "@/features/draft-review/DraftReviewProvider";
import { useOpenReviewChanges } from "@/features/draft-review/useOpenReviewChanges";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ReviewAddressOwner } from "../ReviewAddressOwner";
import type { AiDraftLaunchTarget } from "./editor-review-handoff";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
  useOpenEditorReview,
} from "./editor-review-handoff";

type Open = { documentId: string; itemKey: string; shown: boolean } | null;
type Model = {
  inline: Open;
  /** `active` once the review has its projection. */
  preview: { status: "active" | "gone" } | null;
  changes: { id: string }[];
};

// The projection read is the one boundary that needs an editor; the claimant is what these tests drive.
vi.mock("@/features/draft-review/useOpenReviewChanges", () => ({ useOpenReviewChanges: vi.fn() }));

const target: AiDraftLaunchTarget = {
  workId: "work-1",
  documentId: "doc-1",
  itemKey: "draft-1",
  contextLocation: { scheme: "manuscript", path: "chapters/one.md" },
  focusChangeIds: ["change-2"],
};
const other = { documentId: "doc-0", itemKey: "draft-0" };
const changes = [{ id: "change-1" }, { id: "change-2" }];

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
    vi.mocked(useOpenReviewChanges).mockReturnValue({
      status: state.preview ? (state.preview.status === "active" ? "ready" : "gone") : "loading",
      changes: state.changes,
    } as unknown as ReturnType<typeof useOpenReviewChanges>);
    fixture.update = (next) => setState((previous) => ({ ...previous, ...next }));
    fixture.mountEditor = () => setMounted(true);
    fixture.nameDraftInAddress = () => setAddressed(true);
    const files = [
      {
        documentId: target.documentId,
        documentName: "One",
        contextLocation: target.contextLocation,
        draft: { itemKey: target.itemKey },
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
          <ReviewAddressOwner
            review={review}
            admission="admitted"
            presented={{
              container: "editor",
              documentId: target.documentId,
              scheme: "manuscript",
              path: target.contextLocation.path,
              draftOnly: false,
              review: addressed
                ? { workId: review.controller.workId, itemKey: target.itemKey }
                : null,
            }}
            port={{
              write: (address) => vi.fn()(address?.itemKey ?? null),
              admit: (target) => fixture.openReview?.(target),
            }}
          />
        )}
        <DraftReviewBoundary value={review}>
          <EditorReviewIntentClaimant editorWorkId={target.workId} activeScheme="manuscript" />
        </DraftReviewBoundary>
      </EditorReviewHandoffProvider>
    );
  }
  return { Harness, controls: fixture };
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

const requested = { documentId: target.documentId, itemKey: target.itemKey };

describe("opening a review on given changes", () => {
  it("focuses the change once the requested review has painted and loaded", async () => {
    await launch(target, {}, async ({ enterInlineReview, focusReviewChange, update }) => {
      expect(enterInlineReview).toHaveBeenCalledWith("doc-1", "draft-1");
      // Entered but not painted, then painted but not loaded: nothing yet.
      await act(async () => update?.({ inline: { ...requested, shown: false } }));
      await act(async () => update?.({ inline: { ...requested, shown: true } }));
      expect(focusReviewChange).not.toHaveBeenCalled();
      await act(async () => update?.({ preview: { status: "active" }, changes }));
      expect(focusReviewChange).toHaveBeenCalledOnce();
      expect(focusReviewChange).toHaveBeenCalledWith(requested, "change-2", { scroll: true });
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
        expect(focusReviewChange).toHaveBeenCalledExactlyOnceWith(requested, "change-2", {
          scroll: true,
        }),
    );
  });

  it("opens at the top when none of the changes is in the review any more", async () => {
    await launch(
      { ...target, focusChangeIds: ["change-gone"] },
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
        expect(focusReviewChange).toHaveBeenCalledExactlyOnceWith(requested, "change-2", {
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

  it("does not focus a launch that names no change", async () => {
    await launch(
      { ...target, focusChangeIds: undefined },
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
    const { enterInlineReview, focusReviewChange, route } = fixture.controls;
    enterInlineReview.mockImplementation((documentId: string, itemKey: string) =>
      fixture.controls.update({ inline: { documentId, itemKey, shown: false } }),
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
      expect(focusReviewChange).toHaveBeenCalledExactlyOnceWith(requested, "change-2", {
        scroll: true,
      });
    });
  });
});
