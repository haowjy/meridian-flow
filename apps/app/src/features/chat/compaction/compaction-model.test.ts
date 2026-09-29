/** Divider states, undo markers, and R4's hidden overflow shell. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  answeredControlIds,
  collectUndoMarkers,
  dividerView,
  isOverflowShell,
  NO_UNDO_MARKERS,
  readCompactionFacts,
} from "./compaction-model";

function compaction(
  overrides: Partial<Turn> & { metadata?: unknown; summary?: string } = {},
): Turn {
  const { summary, ...rest } = overrides;
  return {
    id: "c",
    role: "compaction",
    status: "complete",
    error: null,
    metadata: { trigger: "manual", controlMessageId: "k" },
    blocks: summary
      ? [
          {
            id: "b",
            blockType: "custom",
            sequence: 0,
            content: {
              kind: "compaction",
              props: { summary, tokensBefore: 40_000, tokensAfter: 9_000 },
            },
          },
        ]
      : [],
    ...rest,
  } as unknown as Turn;
}

function undoMarker(
  id: string,
  status: "complete" | "error",
  target = "c",
  extra: { error?: string; controlMessageId?: string; reason?: string } = {},
): Turn {
  return {
    id,
    role: "system",
    status,
    error: extra.error ?? null,
    metadata: {
      kind: "compaction_undo",
      revertsCompactionTurnId: target,
      ...(extra.controlMessageId ? { controlMessageId: extra.controlMessageId } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    },
    blocks: [],
  } as unknown as Turn;
}

const failureCopyFor = (reason: string | null, server: string | null) =>
  reason === "context_too_large" ? "client copy" : server;

function view(
  turn: Turn,
  options: {
    markers?: ReturnType<typeof collectUndoMarkers> extends Map<string, infer M> ? M : never;
    undo?: { turnId: string; availability: "likely" | "would_recompact" } | null;
    undoQueued?: boolean;
  } = {},
) {
  return dividerView({
    turn,
    markers: options.markers ?? NO_UNDO_MARKERS,
    undoAvailability: options.undo ?? null,
    undoQueued: options.undoQueued ?? false,
    failureCopyFor,
  });
}

describe("readCompactionFacts", () => {
  it("reads the summary block, tokens, trigger, and the command it ran", () => {
    const facts = readCompactionFacts(compaction({ summary: "Earlier chapters" }));
    expect(facts).toMatchObject({
      trigger: "manual",
      summary: "Earlier chapters",
      tokensBefore: 40_000,
      tokensAfter: 9_000,
      controlId: "k",
    });
    expect(readCompactionFacts(compaction({ metadata: { trigger: "auto" } })).controlId).toBeNull();
  });

  it("treats a divider with a control id and no trigger as manual", () => {
    expect(readCompactionFacts(compaction({ metadata: { controlMessageId: "k" } })).trigger).toBe(
      "manual",
    );
  });
});

describe("dividerView", () => {
  it("pending: compacting, no undo", () => {
    expect(
      view(compaction({ status: "pending" }), { undo: { turnId: "c", availability: "likely" } }),
    ).toMatchObject({ state: "pending", offerUndo: false, failureCopy: null });
  });

  it("complete: summary, tokens when smaller, and Undo on the snapshot's divider", () => {
    const result = view(compaction({ summary: "S" }), {
      undo: { turnId: "c", availability: "likely" },
    });
    expect(result).toMatchObject({
      state: "complete",
      summary: "S",
      tokens: { before: 40_000, after: 9_000 },
      offerUndo: true,
    });
  });

  it("hides tokens when the context did not shrink", () => {
    const grown = compaction();
    (grown as { blocks: unknown[] }).blocks = [
      {
        id: "b",
        blockType: "custom",
        sequence: 0,
        content: {
          kind: "compaction",
          props: { summary: "S", tokensBefore: 48, tokensAfter: 5_317 },
        },
      },
    ];
    expect(view(grown).tokens).toBeNull();
  });

  it("offers Undo only on the divider the snapshot names", () => {
    expect(
      view(compaction(), { undo: { turnId: "other", availability: "likely" } }).offerUndo,
    ).toBe(false);
  });

  it("offers Undo only where the server marks it likely to succeed", () => {
    expect(
      view(compaction(), { undo: { turnId: "c", availability: "would_recompact" } }).offerUndo,
    ).toBe(false);
  });

  it("failed manual: says why, with client copy where the server's would blame the writer", () => {
    expect(
      view(
        compaction({
          status: "error",
          error: "This conversation couldn't be compacted. Try again.",
          metadata: { trigger: "manual", reason: "provider_error", phase: "summary" },
        }),
      ),
    ).toMatchObject({
      state: "failed",
      nothingToCompact: false,
      failureCopy: "This conversation couldn't be compacted. Try again.",
    });
    expect(
      view(
        compaction({
          status: "error",
          error: "This message is too long for this chat's model.",
          metadata: { trigger: "manual", reason: "context_too_large", phase: "initial_prepare" },
        }),
      ).failureCopy,
    ).toBe("client copy");
  });

  it("nothing to compact: a calm outcome with no failure copy", () => {
    expect(
      view(
        compaction({
          status: "error",
          error: "There is nothing to compact yet.",
          metadata: { trigger: "manual", reason: "nothing_to_compact", phase: "initial_prepare" },
        }),
      ),
    ).toMatchObject({ state: "failed", nothingToCompact: true, failureCopy: null });
  });

  it("failed auto stays quiet (R3): the failed reply carries the error", () => {
    expect(
      view(
        compaction({
          status: "error",
          error: "This conversation couldn't be compacted. Try again.",
          metadata: { trigger: "auto", reason: "provider_error", phase: "summary" },
        }),
      ),
    ).toMatchObject({ state: "failed", trigger: "auto", failureCopy: null });
  });

  it("cancelled", () => {
    expect(view(compaction({ status: "cancelled" })).state).toBe("cancelled");
  });

  it("undone: a complete U folds into the divider; Undo is gone", () => {
    const markers = collectUndoMarkers([compaction(), undoMarker("u", "complete")]).get("c");
    expect(
      view(compaction(), { markers, undo: { turnId: "c", availability: "likely" } }),
    ).toMatchObject({ state: "undone", offerUndo: false, refusalCopy: null });
  });

  it("refused: the U's writer copy shows on the divider it targeted", () => {
    const markers = collectUndoMarkers([
      compaction(),
      undoMarker("u", "error", "c", {
        error: "Undo would make this conversation compact again immediately.",
        reason: "would_recompact",
      }),
    ]).get("c");
    expect(
      view(compaction(), { markers, undo: { turnId: "c", availability: "would_recompact" } }),
    ).toMatchObject({
      state: "complete",
      refusalCopy: "Undo would make this conversation compact again immediately.",
      offerUndo: false,
    });
  });

  it("a queued undo withdraws the offer and the old refusal until it runs", () => {
    const markers = collectUndoMarkers([
      compaction(),
      undoMarker("u", "error", "c", { error: "refused" }),
    ]).get("c");
    expect(
      view(compaction(), {
        markers,
        undo: { turnId: "c", availability: "likely" },
        undoQueued: true,
      }),
    ).toMatchObject({ offerUndo: false, refusalCopy: null });
  });
});

describe("collectUndoMarkers", () => {
  it("keeps the latest refusal and lets a success win", () => {
    const markers = collectUndoMarkers([
      undoMarker("u1", "error", "c", { error: "first" }),
      undoMarker("u2", "error", "c", { error: "second" }),
    ]).get("c");
    expect(markers?.refusal?.id).toBe("u2");
    const after = collectUndoMarkers([
      undoMarker("u1", "error", "c"),
      undoMarker("u2", "complete", "c"),
      undoMarker("u3", "error", "c", { reason: "already_undone" }),
    ]).get("c");
    expect(after).toMatchObject({ undone: { id: "u2" }, refusal: null });
  });
});

describe("answeredControlIds", () => {
  it("collects the commands a divider or undo marker ran as, and nothing else", () => {
    const ids = answeredControlIds([
      compaction({ metadata: { trigger: "manual", controlMessageId: "k1" } }),
      compaction({ id: "c2", metadata: { trigger: "auto" } }),
      undoMarker("u", "complete", "c", { controlMessageId: "k3" }),
    ]);
    expect([...ids].sort()).toEqual(["k1", "k3"]);
  });
});

describe("isOverflowShell (R4)", () => {
  const empty = { id: "a", role: "assistant", status: "complete", blocks: [] } as unknown as Turn;
  it("hides an empty complete assistant turn right before a compaction", () => {
    expect(isOverflowShell(empty, compaction())).toBe(true);
  });
  it("keeps it when it has content, is not complete, or no compaction follows", () => {
    expect(isOverflowShell({ ...empty, blocks: [{}] } as unknown as Turn, compaction())).toBe(
      false,
    );
    expect(isOverflowShell({ ...empty, status: "error" } as Turn, compaction())).toBe(false);
    expect(isOverflowShell(empty, undefined)).toBe(false);
  });
});
