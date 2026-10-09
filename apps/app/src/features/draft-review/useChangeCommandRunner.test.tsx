// @vitest-environment jsdom
/** A throwing or rejected batch releases every queued selection; provider suites own command claims. */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { currentChangeCommandRecords } from "@/client/query/change-command-record";
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
  it.each([
    "throw",
    "reject",
  ] as const)("gives back every queued selection when the command %ss", async (kind) => {
    resetDraftCommandRecords();
    const command = vi.fn(() => {
      if (kind === "throw") throw new Error("injected");
      return Promise.reject(new Error("injected"));
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
        expect(currentChangeCommandRecords().queued).toEqual({});
        expect(command).toHaveBeenCalledTimes(1);
      },
    );
  });
});
