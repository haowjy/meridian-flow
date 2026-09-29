/** Divider states, answered commands, and R4's hidden overflow shell. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  answeredControlIds,
  dividerView,
  isOverflowShell,
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

const failureCopyFor = (reason: string | null, server: string | null) =>
  reason === "context_too_large" ? "client copy" : server;

function view(turn: Turn) {
  return dividerView({ turn, failureCopyFor });
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
  it("pending: compacting, no failure copy", () => {
    expect(view(compaction({ status: "pending" }))).toMatchObject({
      state: "pending",
      failureCopy: null,
    });
  });

  it("complete: summary, and tokens when smaller", () => {
    expect(view(compaction({ summary: "S" }))).toMatchObject({
      state: "complete",
      summary: "S",
      tokens: { before: 40_000, after: 9_000 },
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
      instructions: null,
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

  it("carries the writer's instructions verbatim; blank or malformed is none", () => {
    const withInstructions = (instructions: string | number | null) =>
      view(compaction({ metadata: { trigger: "manual", controlMessageId: "k", instructions } }))
        .instructions;
    expect(withInstructions("  Keep the oath\n")).toBe("  Keep the oath\n");
    expect(withInstructions("   ")).toBeNull();
    expect(withInstructions(7)).toBeNull();
    expect(withInstructions(null)).toBeNull();
  });
});

describe("answeredControlIds", () => {
  it("collects the commands a divider ran as, and nothing else", () => {
    const ids = answeredControlIds([
      compaction({ metadata: { trigger: "manual", controlMessageId: "k1" } }),
      compaction({ id: "c2", metadata: { trigger: "auto" } }),
      { id: "u", role: "user", status: "complete", blocks: [] } as unknown as Turn,
    ]);
    expect([...ids]).toEqual(["k1"]);
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
