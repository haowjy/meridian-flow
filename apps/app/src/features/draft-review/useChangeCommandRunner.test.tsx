// @vitest-environment jsdom
/** A throwing or rejected batch releases every queued selection; provider suites own command claims. */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  currentChangeCommandRecords,
  hiddenOperationIds,
} from "@/client/query/change-command-record";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { DraftReviewBoundary, type DraftReviewContextValue } from "./DraftReviewProvider";
import { type ChangeCommandRunner, useChangeCommandRunner } from "./useChangeCommandRunner";

const scope = (workId: string, command = vi.fn()) =>
  ({
    controller: { projectId: "p", workId, inlineReview: null, applyChanges: command },
  }) as unknown as DraftReviewContextValue;

const item = (id: string) => ({
  draft: { documentId: id, draftId: id },
  selection: { classIds: [id], operationIds: [id] },
});

describe("useChangeCommandRunner", () => {
  // Real controllers return promises, so their synchronous-throw branch cannot be
  // reached at a dependency boundary. Keep this small runner risk witness;
  // C-owner covers rejection through the real query cache instead.
  it("gives back every queued selection on a synchronous controller throw", async () => {
    resetDraftCommandRecords();
    const command = vi.fn(() => {
      throw new Error("injected");
    });
    let runner!: ChangeCommandRunner;
    function Consumer() {
      runner = useChangeCommandRunner(scope("a", command).controller);
      return null;
    }
    await withReactRoot(
      <DraftReviewBoundary value={scope("editor")}>
        <Consumer />
      </DraftReviewBoundary>,
      async () => {
        await act(async () => {
          await expect(runner.applyBatch([item("1"), item("2")])).rejects.toThrow("injected");
        });
        expect(
          hiddenOperationIds(currentChangeCommandRecords(), {
            projectId: "p",
            workId: "a",
            documentId: "1",
            draftId: "1",
          }).size,
        ).toBe(0);
        expect(
          hiddenOperationIds(currentChangeCommandRecords(), {
            projectId: "p",
            workId: "a",
            documentId: "2",
            draftId: "2",
          }).size,
        ).toBe(0);
        expect(command).toHaveBeenCalledTimes(1);
      },
    );
  });
});
