// @vitest-environment jsdom
/**
 * The runner a surface sends a selection of changes through: a batch keeps the
 * caller it began with, every selection it hid at the click is given back when
 * its command ends (or throws), and a queued selection never stands in for the
 * draft's claim. Controllers are stand-ins here; the claim's completion and its
 * generation are `DraftReviewProvider.generation.test.tsx`, through the real provider.
 */
import { act, useState } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  currentChangeCommandRecords,
  hiddenOperationIds,
  queueChangeSelection,
} from "@/client/query/change-command-record";
import {
  beginDraftCommand,
  releaseDraftCommand,
  resetDraftCommandRecords,
} from "@/client/query/draft-command-record";
import {
  useWorkReviewScope,
  WorkReviewScopesProvider,
} from "@/features/project/work/useWorkReviewScope";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  EditorReviewScope,
} from "./DraftReviewProvider";
import { type ChangeCommandRunner, useChangeCommandRunner } from "./useChangeCommandRunner";
import type { DraftReviewController } from "./useDraftReviewController";

const scope = (workId: string, command = vi.fn()) =>
  ({
    controller: { projectId: "p", workId, inlineReview: null, applyChanges: command },
  }) as unknown as DraftReviewContextValue;

const item = (id: string) => ({
  draft: { documentId: id, draftId: id },
  selection: { classIds: [id], operationIds: [id] },
});

describe("useChangeCommandRunner", () => {
  it("is offered the Work scopes by the documented providers", () => {
    const editor = scope("a");
    const chat = scope("b");
    const third = scope("c");
    function Consumer() {
      useWorkReviewScope("c");
      return null;
    }
    expect(() =>
      renderToString(
        <EditorReviewScope value={editor}>
          <WorkReviewScopesProvider chat={chat} third={third}>
            <Consumer />
          </WorkReviewScopesProvider>
        </EditorReviewScope>,
      ),
    ).not.toThrow();
  });

  it("keeps the caller a batch began with after the caller changes Work", async () => {
    let answer!: (value: unknown) => void;
    const a = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue({ kind: "change-settled", mode: "apply" });
    const b = vi.fn(async () => ({ kind: "blocked" }));
    const callerA = scope("a", a).controller;
    const callerB = scope("b", b).controller;
    let setCaller!: (controller: DraftReviewController) => void;
    let runner!: ChangeCommandRunner;
    function Consumer() {
      const [caller, set] = useState(callerA);
      setCaller = set;
      runner = useChangeCommandRunner(caller);
      return null;
    }
    await withReactRoot(
      <DraftReviewBoundary value={scope("editor")}>
        <Consumer />
      </DraftReviewBoundary>,
      async () => {
        let done!: Promise<unknown>;
        const items = [item("1"), item("2")];
        await act(async () => {
          done = runner.applyBatch(items);
        });
        await act(async () => setCaller(callerB));
        await act(async () => {
          answer({ kind: "change-settled", mode: "apply" });
          await done;
        });
        expect(a).toHaveBeenCalledTimes(2);
        expect(a).toHaveBeenLastCalledWith(items[1].draft, items[1].selection);
        expect(b).not.toHaveBeenCalled();
      },
    );
  });

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

  it("hides a queued selection without ever blocking the draft's claim", () => {
    resetDraftCommandRecords();
    const draft = { projectId: "p", workId: "w", documentId: "d", draftId: "r" };
    const retire = queueChangeSelection(draft, { classIds: ["c"], operationIds: ["o"] });
    expect(hiddenOperationIds(currentChangeCommandRecords(), draft)).toEqual(new Set(["o"]));
    expect(beginDraftCommand(draft)).toBe(true);
    releaseDraftCommand(draft);
    retire();
    retire();
    expect(currentChangeCommandRecords().queued).toEqual({});
  });
});
