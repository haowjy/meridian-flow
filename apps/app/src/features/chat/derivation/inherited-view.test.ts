/** A fork's inherited view: pages folded into owned turns, the optimistic prefix, and paging. */
import type { TranscriptPageResponse, Turn } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ readThreadTranscript: vi.fn() }));
vi.mock("@/client/api/threads-api", () => api);
vi.mock("@/client/stores", () => ({ useIsThreadPendingCreation: () => false }));

import {
  inheritedQueryOptions,
  inheritedViewFromPages,
  optimisticForkPrefix,
} from "./inherited-view";

const turn = (id: string, threadId: string, role = "user") =>
  ({ id, threadId, role, status: "complete", blocks: [] }) as unknown as Turn;
const entry = (id: string, owner: string) => ({
  turn: turn(id, owner),
  blocks: [{ id: `${id}-b` }] as unknown as TranscriptPageResponse["entries"][number]["blocks"],
  ownerThreadId: owner,
});
const page = (
  entries: TranscriptPageResponse["entries"],
  extra: Partial<TranscriptPageResponse> = {},
): TranscriptPageResponse => ({
  entries,
  owners: [
    { threadId: "grand", ref: "c1", title: "Arc 3", trashed: true },
    { threadId: "source", ref: "c2", title: "Chapter 12 plan", trashed: false },
  ],
  segment: { index: 0, bakeId: null, openedBy: null },
  segmentBoundary: false,
  hasMore: false,
  ...extra,
});

beforeEach(() => api.readThreadTranscript.mockReset());

describe("inheritedViewFromPages", () => {
  it("joins each turn with its blocks and owner, and keeps the owners' trash state", () => {
    const view = inheritedViewFromPages([page([entry("g1", "grand"), entry("s1", "source")])]);
    expect(view.transcript.turns.map((t) => [t.id, t.blocks.length])).toEqual([
      ["g1", 1],
      ["s1", 1],
    ]);
    expect(view.transcript.ownerByTurnId.get("g1")).toBe("grand");
    expect(view.owners.get("grand")).toEqual({ threadId: "grand", title: "Arc 3", trashed: true });
  });
});

describe("inheritedQueryOptions", () => {
  it("reads the inherited range oldest first, across segment boundaries, until the end", async () => {
    api.readThreadTranscript
      .mockResolvedValueOnce(
        page([entry("s1", "source")], { hasMore: true, segmentBoundary: true, nextCursor: "n1" }),
      )
      .mockResolvedValueOnce(page([entry("s2", "source")]));
    const client = new QueryClient();
    const view = await client.fetchQuery(inheritedQueryOptions("fork"));
    expect(api.readThreadTranscript.mock.calls.map((call) => call[1])).toEqual([
      { range: "inherited", order: "oldest_first", unit: "turn", limit: 200 },
      { range: "inherited", order: "oldest_first", unit: "turn", limit: 200, cursor: "n1" },
    ]);
    expect(view.transcript.turns.map((t) => t.id)).toEqual(["s1", "s2"]);
  });
});

describe("optimisticForkPrefix", () => {
  it("takes the source's rows through the cutoff, keeping inherited owners", () => {
    const sourceInherited = inheritedViewFromPages([page([entry("g1", "grand")])]);
    const prefix = optimisticForkPrefix({
      source: { id: "source", title: "Chapter 12 plan" },
      sourceInherited,
      localTurns: [turn("s1", "source"), turn("s2", "source", "assistant"), turn("s3", "source")],
      cutoffTurnId: "s2",
    });
    expect(prefix?.transcript.turns.map((t) => t.id)).toEqual(["g1", "s1", "s2"]);
    expect([...(prefix?.transcript.ownerByTurnId ?? [])]).toEqual([
      ["g1", "grand"],
      ["s1", "source"],
      ["s2", "source"],
    ]);
    expect(prefix?.owners.get("source")?.title).toBe("Chapter 12 plan");
  });

  it("cuts at an inherited turn of a fork, inheriting only above it", () => {
    const sourceInherited = inheritedViewFromPages([
      page([entry("g1", "grand"), entry("g2", "grand")]),
    ]);
    const prefix = optimisticForkPrefix({
      source: { id: "source", title: null },
      sourceInherited,
      localTurns: [turn("s1", "source")],
      cutoffTurnId: "g1",
    });
    expect(prefix?.transcript.turns.map((t) => t.id)).toEqual(["g1"]);
  });

  it("shows nothing it cannot place: an unknown cutoff yields no prefix", () => {
    expect(
      optimisticForkPrefix({
        source: { id: "source", title: null },
        sourceInherited: null,
        localTurns: [turn("s1", "source")],
        cutoffTurnId: "missing",
      }),
    ).toBeNull();
  });
});
