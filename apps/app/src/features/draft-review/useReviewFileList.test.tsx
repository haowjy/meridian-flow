// @vitest-environment jsdom
/**
 * The file list's rendering isolation: moving focus among the open file's
 * changes moves `view` and nothing else, and must hand `ReviewFiles` the same
 * file objects so no closed row renders again.
 */
import { act, type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ReviewFiles } from "./ReviewFiles";
import type { ReviewChangesView } from "./useReviewChanges";
import { useReviewFileList } from "./useReviewFileList";

const statsRendered = vi.hoisted(() => vi.fn());
vi.mock("./draft-stats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./draft-stats")>()),
  DraftStatsLabel: () => {
    statsRendered();
    return null;
  },
}));

const group = (documentId: string, name: string): ThreadDraftGroup =>
  ({
    documentId,
    documentName: name,
    contextPath: `/${name}.md`,
    draft: {
      draftId: `draft-${documentId}`,
      documentId,
      documentName: name,
      contextPath: `/${name}.md`,
      status: "active",
      lastActorTurnId: null,
      updatedAt: "2026-01-01T00:00:00Z",
      wordsAdded: 4,
      wordsRemoved: 0,
    },
  }) as unknown as ThreadDraftGroup;

const groups = [
  group("doc-1", "Chapter 1"),
  group("doc-2", "Chapter 2"),
  group("doc-3", "Chapter 3"),
];
const controller = {
  projectId: "p",
  workId: "w",
  inlineReview: { kind: "inline", documentId: "doc-2", draftId: "draft-doc-2" },
  dispositionLocked: false,
  disposeDrafts: vi.fn(async () => []),
} as never;

const viewOf = (focusedId: string | null, count = 3) =>
  ({
    status: "ready",
    finished: false,
    completing: null,
    unlisted: false,
    items: Array.from({ length: count }, (_, index) => ({ change: { classId: `c${index}` } })),
    focused: focusedId ? { classId: focusedId } : null,
  }) as unknown as ReviewChangesView;

describe("useReviewFileList", () => {
  it("hands over the same files when only the focus moved, and renews just the open file when its count changes", async () => {
    resetDraftCommandRecords();
    const seen: ReturnType<typeof useReviewFileList>[] = [];
    function Probe({ view }: { view: ReviewChangesView }) {
      seen.push(useReviewFileList({ review: { controller, groups }, view, openDraft: vi.fn() }));
      return null;
    }
    let setView!: (next: ReviewChangesView) => void;
    function Host(): ReactNode {
      const [view, set] = useState(viewOf("c0"));
      setView = set;
      return <Probe view={view} />;
    }
    await withReactRoot(<Host />, async () => {
      const first = seen.at(-1);
      await act(async () => setView(viewOf("c1")));
      const second = seen.at(-1);
      expect(second?.files).toBe(first?.files);
      expect(second?.batch).toBe(first?.batch);

      await act(async () => setView(viewOf("c1", 4)));
      const third = seen.at(-1);
      expect(third?.files).not.toBe(first?.files);
      const byKey = (list: typeof first) =>
        Object.fromEntries((list?.files ?? []).map((f) => [f.key, f]));
      expect(byKey(third)["w:doc-1"]).toBe(byKey(first)["w:doc-1"]);
      expect(byKey(third)["w:doc-3"]).toBe(byKey(first)["w:doc-3"]);
      expect(byKey(third)["w:doc-2"].changeCount).toBe(4);
    });
  });

  it("does not render a closed row again when ReviewFiles renders with the same file objects", async () => {
    const file = {
      key: "w:doc-1",
      name: "Chapter 1",
      held: false,
      open: false,
      isNewDocument: false,
      changeCount: null,
      stats: { kind: "words" as const, added: 4, removed: 0 },
      error: null,
      onOpen: vi.fn(),
      onDismissError: vi.fn(),
    };
    const files = [file];
    let rerender!: (next?: typeof files) => void;
    function Host() {
      const [list, setList] = useState(files);
      rerender = (next) => setList(next ?? [...list]);
      return <ReviewFiles files={list} />;
    }
    await withReactRoot(<Host />, async () => {
      const before = statsRendered.mock.calls.length;
      expect(before).toBeGreaterThan(0);
      // The list renders again around the same file: its row does not.
      await act(async () => rerender());
      expect(statsRendered.mock.calls.length).toBe(before);
      // A changed file renders again.
      await act(async () => rerender([{ ...file, name: "Chapter 1b" }]));
      expect(statsRendered.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
