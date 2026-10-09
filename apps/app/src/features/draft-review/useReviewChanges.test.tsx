// @vitest-environment jsdom
/**
 * useReviewChanges and useArrivedChanges against a real query cache: what the
 * writer sees as the review's changes, through their own commands and while the
 * AI keeps writing.
 */
import type { DraftPreviewResponse, ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { selectionOf } from "./change-selection";
import { useArrivedChanges } from "./useArrivedChanges";
import type { DraftReviewController } from "./useDraftReviewController";
import { type ReviewChangesView, useReviewChanges } from "./useReviewChanges";

const getDraftPreview = vi.hoisted(() => vi.fn());
vi.mock("@/client/api/drafts-api", () => ({ getDraftPreview }));

const op = (operationId: string, closureClassId: string, kind: "agent" | "writer" = "agent") =>
  ({
    operationId,
    closureClassId,
    kind,
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
    afterExcerpt: `text ${operationId}`,
  }) as ReviewOperation;
const hunk = (hunkId: string, operationIds: string[]) =>
  ({
    kind: "text",
    hunkId,
    operationIds,
    anchor: { relStart: "", relEnd: "" },
    spans: [],
  }) as ReviewHunk;

function preview(
  operations: ReviewOperation[],
  hunks: ReviewHunk[],
  extra: Partial<Extract<DraftPreviewResponse, { status: "active" }>> = {},
): DraftPreviewResponse {
  return {
    status: "active",
    draftId: "draft",
    draftGeneration: 1,
    reviewRoomName: "room",

    liveRevisionToken: "l",
    draftRevisionToken: "t",
    inlineModelPresent: true,
    operations,
    hunks,
    ...extra,
  };
}

const inReview = { documentId: "doc", draftId: "draft" };
const key = projectQueryKeys.workDraftPreview("p", "w", "doc", "draft");

const baseline = () =>
  preview(
    [op("1", "c1"), op("2", "c2"), op("3", "c3")],
    [hunk("h1", ["1"]), hunk("h2", ["2"]), hunk("h3", ["3"])],
  );

function fakeController(overrides: Partial<DraftReviewController> = {}) {
  return {
    projectId: "p",
    workId: "w",
    inlineReview: { kind: "inline", documentId: "doc", draftId: "draft" },
    focus: null,
    dispositionLocked: false,
    focusReviewChange: vi.fn(),
    applyChanges: vi.fn(async () => ({ kind: "change-settled", mode: "apply" })),
    discardChanges: vi.fn(async () => ({ kind: "change-settled", mode: "discard" })),
    ...overrides,
  } as unknown as DraftReviewController;
}

let latest: ReviewChangesView;
let arrived: ReadonlySet<string>;

function Probe({ controller }: { controller: DraftReviewController }) {
  latest = useReviewChanges(controller);
  arrived = useArrivedChanges(
    latest.items.map((item) => item.change),
    latest.status === "ready",
    "doc:draft",
  );
  return null;
}

async function mount(
  controller: DraftReviewController,
  run: (client: QueryClient) => Promise<void>,
  seed: DraftPreviewResponse | null = baseline(),
  options: { drainMacrotask?: boolean } = { drainMacrotask: true },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) client.setQueryData(key, seed);
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Probe controller={controller} />
    </QueryClientProvider>,
    () => run(client),
    options,
  );
}

/** Let the query cache notify its observers (it batches on a macrotask), then render. */
const flush = (ms = 0) =>
  act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

beforeEach(() => {
  resetDraftCommandRecords();
  getDraftPreview.mockReset();
});

describe("useReviewChanges", () => {
  it("new AI writes arrive in place: the count rises and the new change pulses once", async () => {
    await mount(fakeController(), async (client) => {
      expect(latest.items).toHaveLength(3);
      expect([...arrived]).toEqual([]);
      client.setQueryData(
        key,
        preview(
          [op("1", "c1"), op("2", "c2"), op("3", "c3"), op("4", "c4")],
          [hunk("h1", ["1"]), hunk("h2", ["2"]), hunk("h3", ["3"]), hunk("h4", ["4"])],
        ),
      );
      await flush();
      expect(latest.items).toHaveLength(4);
      expect([...arrived]).toEqual(["c4"]);
      await flush(1600);
      expect([...arrived]).toEqual([]);
    });
  });

  it("the writer's own typing is not an arrival", async () => {
    await mount(fakeController(), async (client) => {
      client.setQueryData(
        key,
        preview(
          [op("1", "c1"), op("2", "c2"), op("3", "c3"), op("w", "cw", "writer")],
          [hunk("h1", ["1"]), hunk("h2", ["2"]), hunk("h3", ["3"]), hunk("hw", ["w"])],
        ),
      );
      await flush();
      expect(latest.items).toHaveLength(4);
      expect([...arrived]).toEqual([]);
    });
  });

  it("steps through the changes in order and wraps, landing on the first before any focus", async () => {
    const controller = fakeController();
    await mount(controller, async () => {
      await act(async () => latest.step(1));
      expect(controller.focusReviewChange).toHaveBeenLastCalledWith(
        inReview,
        expect.objectContaining({ classId: "c1" }),
        { scroll: true },
      );
      await act(async () => latest.step(-1));
      expect(controller.focusReviewChange).toHaveBeenLastCalledWith(
        inReview,
        expect.objectContaining({ classId: "c3" }),
        { scroll: true },
      );
    });
    const focused = fakeController({
      focus: { classId: "c3", operationIds: ["3"] },
    } as Partial<DraftReviewController>);
    await mount(focused, async () => {
      await act(async () => latest.step(1));
      expect(focused.focusReviewChange).toHaveBeenLastCalledWith(
        inReview,
        expect.objectContaining({ classId: "c1" }),
        { scroll: true },
      );
    });
  });

  it("after Apply, lands on the next change; after a refusal, comes back to the change", async () => {
    const controller = fakeController({
      focus: { classId: "c2", operationIds: ["2"] },
    } as Partial<DraftReviewController>);
    await mount(controller, async () => {
      const target = latest.items[1].change;
      await act(async () => {
        await latest.apply(target);
      });
      expect(controller.applyChanges).toHaveBeenCalledWith(inReview, selectionOf([target]));
      expect(controller.focusReviewChange).toHaveBeenCalledWith(
        inReview,
        expect.objectContaining({ classId: "c3" }),
        { scroll: true },
      );
    });
    const refused = fakeController({
      focus: { classId: "c2", operationIds: ["2"] },
      applyChanges: vi.fn(async () => ({ kind: "change-refused", mode: "apply", code: "stale" })),
    } as unknown as Partial<DraftReviewController>);
    await mount(refused, async () => {
      const target = latest.items[1].change;
      await act(async () => {
        await latest.apply(target);
      });
      expect(refused.focusReviewChange).toHaveBeenLastCalledWith(inReview, target, {
        scroll: true,
      });
    });
  });
});
