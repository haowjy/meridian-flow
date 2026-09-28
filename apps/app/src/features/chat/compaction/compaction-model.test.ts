/** Divider states, undo markers, and R4's hidden overflow shell. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  answeredControlIds,
  collectUndoMarkers,
  currentUndoAvailability,
  dividerView,
  isOverflowShell,
  NO_UNDO_MARKERS,
  readCompactionFacts,
} from "./compaction-model";
import type { QueuedControl } from "./thread-controls";

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
    queued?: QueuedControl | null;
  } = {},
) {
  return dividerView({
    turn,
    markers: options.markers ?? NO_UNDO_MARKERS,
    undoAvailability: options.undo ?? null,
    queuedUndo: options.queued ?? null,
    failureCopyFor,
  });
}

const queuedUndo = (status: QueuedControl["status"]): QueuedControl => ({
  id: "undo-k",
  control: { kind: "compaction_undo", compactionTurnId: "c" },
  status,
});

describe("readCompactionFacts", () => {
  it("reads the summary block, tokens, trigger, and control ids", () => {
    const facts = readCompactionFacts(
      compaction({
        summary: "Earlier chapters",
        metadata: { trigger: "auto", satisfiesControlId: "k2" },
      }),
    );
    expect(facts).toMatchObject({
      trigger: "auto",
      summary: "Earlier chapters",
      tokensBefore: 40_000,
      tokensAfter: 9_000,
      controlIds: ["k2"],
    });
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
    ).toMatchObject({ state: "pending", undo: null, failureCopy: null });
  });

  it("complete: summary, tokens when smaller, and Undo on the snapshot's divider", () => {
    const result = view(compaction({ summary: "S" }), {
      undo: { turnId: "c", availability: "likely" },
    });
    expect(result).toMatchObject({
      state: "complete",
      summary: "S",
      tokens: { before: 40_000, after: 9_000 },
      undo: { kind: "offer" },
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
      view(compaction(), { undo: { turnId: "other", availability: "likely" } }).undo,
    ).toBeNull();
  });

  it("offers Undo only where the server marks it likely to succeed", () => {
    expect(
      view(compaction(), { undo: { turnId: "c", availability: "would_recompact" } }).undo,
    ).toBeNull();
  });

  it("still shows an undo already queued when availability turns to would_recompact", () => {
    expect(
      view(compaction(), {
        undo: { turnId: "c", availability: "would_recompact" },
        queued: queuedUndo("queued"),
      }).undo,
    ).toMatchObject({ kind: "queued", control: { id: "undo-k", status: "queued" } });
  });

  it("failed manual: says why, with client copy where the server's would blame the writer", () => {
    expect(
      view(
        compaction({
          status: "error",
          error: "There is nothing to compact yet.",
          metadata: { trigger: "manual", reason: "nothing_to_compact", phase: "initial_prepare" },
        }),
      ),
    ).toMatchObject({ state: "failed", failureCopy: "There is nothing to compact yet." });
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
    ).toMatchObject({ state: "undone", undo: null, refusalCopy: null });
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
      undo: null,
    });
  });

  it("queued undo replaces the offer and the old refusal until it runs", () => {
    const markers = collectUndoMarkers([
      compaction(),
      undoMarker("u", "error", "c", { error: "refused" }),
    ]).get("c");
    expect(
      view(compaction(), {
        markers,
        undo: { turnId: "c", availability: "likely" },
        queued: queuedUndo("queued"),
      }),
    ).toMatchObject({
      undo: { kind: "queued", control: { id: "undo-k", status: "queued" } },
      refusalCopy: null,
    });
  });

  it("a withdrawn undo returns the offer with a note", () => {
    expect(
      view(compaction(), {
        undo: { turnId: "c", availability: "likely" },
        queued: queuedUndo("withdrawn"),
      }),
    ).toMatchObject({ undo: { kind: "offer" }, undoNote: "withdrawn" });
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
  it("collects controls a divider ran or absorbed and undo markers executed", () => {
    const ids = answeredControlIds([
      compaction({ metadata: { trigger: "manual", controlMessageId: "k1" } }),
      compaction({ id: "c2", metadata: { trigger: "auto", satisfiesControlId: "k2" } }),
      undoMarker("u", "complete", "c", { controlMessageId: "k3" }),
    ]);
    expect([...ids].sort()).toEqual(["k1", "k2", "k3"]);
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

describe("currentUndoAvailability", () => {
  const likely = { turnId: "c", availability: "likely" } as const;

  it("passes the snapshot's availability through while nothing compacts", () => {
    expect(currentUndoAvailability([compaction()], likely)).toBe(likely);
  });

  it("withholds Undo everywhere while a newer compaction runs", () => {
    expect(
      currentUndoAvailability([compaction(), compaction({ id: "c2", status: "pending" })], likely),
    ).toBeNull();
  });
});
