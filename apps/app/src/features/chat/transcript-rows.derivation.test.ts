/** Row kinds for fork and handoff: the brief card row, inherited marks, and grouping over rows. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { buildTranscriptModel, type InheritedTranscript } from "./transcript-model";

const turn = (id: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ id, role, status: "complete", blocks: [{ id: `${id}-b` }], ...extra }) as unknown as Turn;
const seed = (id: string, status = "complete", controlMessageId = `k-${id}`) =>
  turn(id, "system", {
    status,
    blocks: status === "complete" ? [{ id: `${id}-b`, blockType: "custom" }] : [],
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "source",
      sourceRef: "c1",
      cutoffTurnId: "cut",
      controlMessageId,
    },
  });
const inherited = (turns: Turn[], owners: Record<string, string>): InheritedTranscript => ({
  turns,
  ownerByTurnId: new Map(Object.entries(owners)),
});
const kinds = (model: ReturnType<typeof buildTranscriptModel>) =>
  model.rows.map((row) => `${row.kind}:${row.turn.id}`);

describe("handoff seed rows", () => {
  it("renders S as its own row kind, pending or settled, never as a turn", () => {
    for (const status of ["pending", "complete", "error", "cancelled"]) {
      const model = buildTranscriptModel([seed("s", status), turn("u", "user")], false);
      expect(kinds(model)).toEqual(["handoff-seed:s", "turn:u"]);
    }
  });

  it("marks only the newest seed as latest, so only it can be retried", () => {
    const model = buildTranscriptModel(
      [seed("s1", "error"), turn("u", "user"), turn("a", "assistant"), seed("s2", "error")],
      false,
    );
    expect(
      model.rows.flatMap((row) => (row.kind === "handoff-seed" ? [[row.turn.id, row.latest]] : [])),
    ).toEqual([
      ["s1", false],
      ["s2", true],
    ]);
  });

  it("ends a reply at a brief card and stops the delivery walk there", () => {
    const notice = turn("n", "system", {
      prevTurnId: "s",
      blocks: [],
      metadata: { kind: "subagent_update", handle: "p1", outcome: "succeeded" },
    });
    const model = buildTranscriptModel(
      [turn("a", "assistant"), { ...seed("s"), prevTurnId: "a" } as Turn, notice],
      false,
    );
    expect(model.continuing).toEqual([false, false]);
    expect(model.deliveryEventsFor("a")).toEqual([]);
  });
});

describe("inherited rows", () => {
  const prefix = inherited(
    [turn("gu", "user"), turn("ga", "assistant"), turn("su", "user"), turn("sa", "assistant")],
    { gu: "grand", ga: "grand", su: "source", sa: "source" },
  );

  it("keeps rows index-aligned with visible turns across inherited and local rows", () => {
    const model = buildTranscriptModel(
      [turn("fu", "user"), turn("fa", "assistant")],
      false,
      prefix,
    );
    expect(model.visibleTurns.map((visible) => visible.id)).toEqual(
      model.rows.map((row) => row.turn.id),
    );
    expect(model.visibleTurns.map((visible) => visible.id)).toEqual([
      "gu",
      "ga",
      "su",
      "sa",
      "fu",
      "fa",
    ]);
  });

  it("marks each owner's first row and the fork point; local rows carry no mark", () => {
    const model = buildTranscriptModel([turn("fu", "user")], false, prefix);
    expect(model.rows.map((row) => row.inherited)).toEqual([
      { ownerThreadId: "grand", startsOwner: true, endsInherited: false },
      { ownerThreadId: "grand", startsOwner: false, endsInherited: false },
      { ownerThreadId: "source", startsOwner: true, endsInherited: false },
      { ownerThreadId: "source", startsOwner: false, endsInherited: true },
      null,
    ]);
  });

  it("marks the fork point even when the fork has no turns of its own", () => {
    const model = buildTranscriptModel([], false, prefix);
    expect(model.rows.at(-1)?.inherited?.endsInherited).toBe(true);
  });

  it("never groups a reply across the fork point or between owners", () => {
    const model = buildTranscriptModel(
      [turn("fa", "assistant")],
      false,
      inherited([turn("ga", "assistant"), turn("sa", "assistant")], { ga: "grand", sa: "source" }),
    );
    expect(model.continuing).toEqual([false, false, false]);
    expect(model.partsByFinalTurnId.get("fa")?.map((part) => part.id)).toEqual(["fa"]);
  });

  it("does not keep an inherited reply open for the fork's own subagents", () => {
    const model = buildTranscriptModel([], true, inherited([turn("sa", "assistant")], { sa: "s" }));
    expect(model.continuing).toEqual([false]);
  });

  it("renders an inherited divider as an inherited compaction row", () => {
    const divider = turn("c", "compaction", { blocks: [], metadata: { trigger: "auto" } });
    const model = buildTranscriptModel(
      [],
      false,
      inherited([turn("su", "user"), divider], { su: "source", c: "source" }),
    );
    const row = model.rows[1];
    expect(row?.kind).toBe("compaction");
    expect(row?.inherited?.ownerThreadId).toBe("source");
  });

  it("renders an inherited brief read-only: it is never the latest seed", () => {
    const model = buildTranscriptModel(
      [seed("own", "error")],
      false,
      inherited([seed("theirs", "error")], { theirs: "source" }),
    );
    expect(
      model.rows.map((row) => (row.kind === "handoff-seed" ? [row.turn.id, row.latest] : null)),
    ).toEqual([
      ["theirs", false],
      ["own", true],
    ]);
  });
});

describe("thread-reference rows", () => {
  it("gives a child's seed references a row of their own; the seed stays a delivery", () => {
    const seedMessage = turn("seed", "user", {
      origin: "system",
      metadata: { kind: "inbox_message", agentRequestKind: "child_seed" },
      blocks: [
        { id: "t", blockType: "text", sequence: 0 },
        {
          id: "r",
          blockType: "custom",
          sequence: 1,
          content: {
            kind: "thread-reference",
            props: { threadId: "source", ref: "c3", title: "Plan" },
          },
        },
      ],
    });
    const model = buildTranscriptModel([seedMessage, turn("a", "assistant")], false);
    expect(kinds(model)).toEqual(["thread-reference:seed", "turn:a"]);
    const row = model.rows[0];
    expect(row?.kind === "thread-reference" && row.references).toEqual([
      { threadId: "source", ref: "c3", title: "Plan" },
    ]);
  });

  it("gives a delivery with no references no row", () => {
    const seedMessage = turn("seed", "user", {
      metadata: { kind: "inbox_message" },
      blocks: [{ id: "t", blockType: "text", sequence: 0 }],
    });
    expect(kinds(buildTranscriptModel([seedMessage], false))).toEqual([]);
  });
});
