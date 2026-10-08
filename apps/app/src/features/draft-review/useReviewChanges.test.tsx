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

import {
  beginChangeCommand,
  failChangeCommand,
  releaseChangeCommand,
} from "@/client/query/change-command-record";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { settleConfirmedChange } from "@/client/query/useDraftReviewMutations";
import { withReactRoot } from "@/test-support/react-dom-harness";
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
const draft = { projectId: "p", workId: "w", documentId: "doc", draftId: "draft" };

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
    applyChange: vi.fn(async () => ({ kind: "change-settled", mode: "apply" })),
    discardChange: vi.fn(async () => ({ kind: "change-settled", mode: "discard" })),
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

const classIds = () => latest.items.map((item) => item.change.classId);

beforeEach(() => {
  resetDraftCommandRecords();
  getDraftPreview.mockReset();
});

describe("useReviewChanges", () => {
  it("lists the changes in document order, with Apply available for a live document", async () => {
    const unordered = preview(
      [op("9", "c9"), op("4", "c4")],
      [hunk("h1", ["4"]), hunk("h2", ["9"])],
    );
    await mount(
      fakeController(),
      async () => {
        expect(classIds()).toEqual(["c4", "c9"]);
        expect(latest.status).toBe("ready");
        expect(latest.canApply).toBe(true);
      },
      unordered,
    );
  });

  it("offers no per-change Apply for a new document", async () => {
    await mount(
      fakeController(),
      async () => expect(latest.canApply).toBe(false),
      preview([op("1", "c1")], [hunk("h1", ["1"])], { isNewDocument: true }),
    );
  });

  it("a change leaves the list the moment its command starts, and returns with its reason on failure", async () => {
    await mount(fakeController(), async () => {
      const second = latest.items[1].change;
      await act(async () => {
        beginChangeCommand(draft, second, "apply");
      });
      expect(classIds()).toEqual(["c1", "c3"]);
      await act(async () => {
        failChangeCommand(draft, second, "apply", "offline");
        releaseChangeCommand(draft);
      });
      expect(classIds()).toEqual(["c1", "c2", "c3"]);
      expect(latest.items[1].failure).toMatchObject({ code: "offline", mode: "apply" });
    });
  });

  it("an applied or discarded change never comes back from a read that was already in flight", async () => {
    let resolveStale!: (value: DraftPreviewResponse) => void;
    getDraftPreview.mockImplementation(
      () => new Promise<DraftPreviewResponse>((resolve) => (resolveStale = resolve)),
    );
    await mount(fakeController(), async (client) => {
      const target = latest.items[0].change;
      // A refetch starts (the AI is still writing)...
      await act(async () => {
        void client.invalidateQueries({ queryKey: key });
      });
      // ...the writer applies a change and the server confirms...
      await act(async () => {
        beginChangeCommand(draft, target, "apply");
        settleConfirmedChange(client, draft, target, "apply");
      });
      expect(classIds()).toEqual(["c2", "c3"]);
      // ...then the read from before the click resolves with the change still in it.
      await act(async () => {
        resolveStale(baseline());
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(classIds()).toEqual(["c2", "c3"]);
    });
  });

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

  it("keeps focus on a change the server regrouped, because it shares an operation", async () => {
    const controller = fakeController({
      focus: { classId: "c2", operationIds: ["2"] },
    } as Partial<DraftReviewController>);
    await mount(controller, async (client) => {
      expect(latest.focused?.classId).toBe("c2");
      client.setQueryData(
        key,
        preview(
          [op("1", "c1"), op("2", "c2b"), op("5", "c2b"), op("3", "c3")],
          [hunk("h1", ["1"]), hunk("h2", ["2", "5"]), hunk("h3", ["3"])],
        ),
      );
      await flush();
      expect(latest.focused?.classId).toBe("c2b");
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
      expect(controller.applyChange).toHaveBeenCalledWith(target);
      expect(controller.focusReviewChange).toHaveBeenCalledWith(
        inReview,
        expect.objectContaining({ classId: "c3" }),
        { scroll: true },
      );
    });
    const refused = fakeController({
      focus: { classId: "c2", operationIds: ["2"] },
      applyChange: vi.fn(async () => ({ kind: "change-refused", mode: "apply", code: "stale" })),
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

  it("reads the lock from the controller so every Apply and Discard disables together", async () => {
    await mount(
      fakeController({ dispositionLocked: true } as Partial<DraftReviewController>),
      async () => expect(latest.locked).toBe(true),
    );
  });

  describe("finished and completing", () => {
    const inline = (completion?: unknown) =>
      fakeController({
        inlineReview: { kind: "inline", documentId: "doc", draftId: "draft", completion },
      } as unknown as Partial<DraftReviewController>);
    const last = () => preview([op("1", "c1")], [hunk("h1", ["1"])]);

    it("is not finished while the last change's command is in flight, however empty the list looks", async () => {
      await mount(
        inline({ phase: "pending", mode: "apply", documentName: "Chapter 12" }),
        async () => {
          await act(async () => {
            beginChangeCommand(draft, latest.items[0].change, "apply");
          });
          expect(classIds()).toEqual([]);
          expect(latest.completing).toBe("apply");
          expect(latest.finished).toBe(false);
        },
        last(),
      );
    });

    it("is not finished while a command hides the last change, even with no completion predicted", async () => {
      await mount(
        inline(),
        async () => {
          await act(async () => {
            beginChangeCommand(draft, latest.items[0].change, "discard");
          });
          expect(classIds()).toEqual([]);
          expect(latest.completing).toBeNull();
          expect(latest.finished).toBe(false);
        },
        last(),
      );
    });

    it("is finished when the server closed the draft, with nothing listed from a stale read", async () => {
      await mount(
        inline({ phase: "closed", documentName: "Chapter 12" }),
        async () => {
          expect(latest.finished).toBe(true);
          expect(latest.completing).toBeNull();
          expect(classIds()).toEqual([]);
        },
        baseline(),
      );
    });

    it("is not finished when the server's own read shows no change: the draft is still open, so formatting remains", async () => {
      await mount(
        inline(),
        async () => {
          expect(latest.finished).toBe(false);
          expect(latest.unlisted).toBe(true);
        },
        preview([], []),
      );
    });

    it("is not unlisted while a command still hides a change", async () => {
      await mount(
        inline(),
        async () => {
          await act(async () => {
            beginChangeCommand(draft, latest.items[0].change, "discard");
          });
          expect(latest.unlisted).toBe(false);
        },
        last(),
      );
    });

    it("is not unlisted once the server closed the draft", async () => {
      await mount(
        inline({ phase: "closed", documentName: "Chapter 12" }),
        async () => expect(latest.unlisted).toBe(false),
        preview([], []),
      );
    });

    it("is not finished or unlisted while an unclassified hunk is the only thing left", async () => {
      const loose = {
        kind: "text",
        hunkId: "h-loose",
        operationIds: [],
        unclassified: true,
        anchor: { relStart: "", relEnd: "" },
        spans: [],
        deletedText: "Alpha",
      } as ReviewHunk;
      await mount(
        inline(),
        async () => {
          expect(classIds()).toHaveLength(1);
          expect(latest.items[0].change.attribution).toEqual({ kind: "unattributed" });
          expect(latest.finished).toBe(false);
          expect(latest.unlisted).toBe(false);
        },
        preview([], [loose]),
      );
    });

    it("is not finished while changes remain", async () => {
      await mount(inline(), async () => expect(latest.finished).toBe(false));
    });
  });
});
