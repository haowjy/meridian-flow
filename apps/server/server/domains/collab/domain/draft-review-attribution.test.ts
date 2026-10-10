/** Real-Yjs draft review behavioral coverage. */
import { toDocHandle } from "@meridian/agent-edit/integration";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { computeDraftReviewOperations } from "./draft-review-operations.js";
import {
  captureUpdate,
  cloneDoc,
  codec,
  createDoc,
  createDraftReviewFixture,
  model,
  spanTextRange,
  type TextEditRow,
} from "./draft-review-test-fixture.js";

const peers: Y.Doc[] = [];
const fixtures: ReturnType<typeof createDraftReviewFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.destroy();
  for (const peer of peers.splice(0)) peer.destroy();
});
function setup(markdown: string, rows?: readonly TextEditRow[]) {
  const fixture = createDraftReviewFixture(markdown, rows);
  fixtures.push(fixture);
  return fixture;
}

describe("draft review attribution", () => {
  it("attributes deleted live text to the row whose delete set covers it", () => {
    const fixture = setup(
      "Alpha sword remains with enough unchanged surrounding text for inline review density.",
      [{ id: 21, actorTurnId: "turn-delete", edits: [[0, 6, 12, ""]] }],
    );
    const result = computeDraftReviewHunks(fixture.input);

    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: ["21"], deletedText: "sword " }),
    ]);
  });

  it("keeps one row that genuinely deletes two regions linked to both hunks", () => {
    const fixture = setup(
      [
        "Alpha target remains with enough unchanged surrounding text for attribution.",
        "Beta target remains with enough unchanged surrounding text for attribution.",
        "Gamma stays unchanged with enough surrounding text for attribution.",
      ].join("\n\n"),
      [
        {
          id: 171,
          actorTurnId: "turn-two-deletions",
          edits: [
            [0, 6, 13, ""],
            [1, 5, 12, ""],
          ],
        },
      ],
    );
    const result = computeDraftReviewHunks(fixture.input);

    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["171"], ["171"]]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "171",
        classification: "removal",
        beforeExcerpt: "target",
        sourceUpdateIds: [171],
        closureUpdateIds: [171],
        actorTurnId: "turn-two-deletions",
        kind: "agent",
      }),
    ]);
  });

  it("keeps an unattributed removal beside an attributed insertion and reports the gap", () => {
    const fixture = setup("Alpha stays.");
    const { live, draft } = fixture;
    const block = model.getBlocks(toDocHandle(draft))[0];
    const updateData = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), block, { from: 0, to: 0 }, "New "),
    );
    const insertedRanges = Y.decodeUpdate(updateData).structs.map((item) => ({
      ...item.id,
      length: item.length,
    }));
    const result = computeDraftReviewOperations({
      baseDoc: live,
      updates: [{ id: 990, actorTurnId: "turn", updateData }],
      hunks: [
        {
          raw: {
            insertedRanges,
            deletedRanges: [{ client: 1, clock: 3, length: 5 }],
            insertedText: "New ",
            deletedText: "Alpha",
          },
          review: {
            kind: "text",
            hunkId: "test",
            operationIds: [],
            spans: [],
            deletedText: "Alpha",
            anchor: { relStart: "", relEnd: "" },
          },
        },
      ],
    });
    expect(result.hunks[0]).toMatchObject({
      deletedText: "Alpha",
      deletedSpans: [],
      unclassified: true,
    });
    expect(result.diagnostics).toEqual([{ code: "unattributed_hunk", hunkId: "test" }]);
    expect(result.operations[0]).toMatchObject({ canApplyOrDiscard: false });
  });

  it("keeps the full partly attributed removal rather than only its known author spans", () => {
    const fixture = setup("Alpha stays.");
    const { live, draft } = fixture;
    const block = model.getBlocks(toDocHandle(draft))[0];
    const updateData = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), block, { from: 0, to: 5 }, ""),
    );
    const known = [...Y.decodeUpdate(updateData).ds.clients].flatMap(([client, ranges]) =>
      ranges.map((range) => ({ client, clock: range.clock, length: range.len })),
    );
    const result = computeDraftReviewOperations({
      baseDoc: live,
      updates: [{ id: 991, actorTurnId: "turn", updateData }],
      hunks: [
        {
          raw: {
            insertedRanges: [],
            deletedRanges: [...known, { client: Number.MAX_SAFE_INTEGER, clock: 3, length: 1 }],
            insertedText: "",
            deletedText: "Alpha?",
          },
          review: {
            kind: "text",
            hunkId: "partial",
            operationIds: [],
            spans: [],
            deletedText: "Alpha?",
            anchor: { relStart: "", relEnd: "" },
          },
        },
      ],
    });
    expect(result.hunks[0]).toMatchObject({
      deletedText: "Alpha?",
      deletedSpans: [],
      unclassified: true,
    });
    expect(result.operations[0]).toMatchObject({ canApplyOrDiscard: false });
    expect(result.diagnostics).toEqual([{ code: "unattributed_hunk", hunkId: "partial" }]);
  });

  it.each([
    "removal",
    "insertion",
  ] as const)("retains a wholly unattributed %s without inventing an author", (kind) => {
    const live = createDoc("Alpha stays.");
    try {
      const result = computeDraftReviewOperations({
        baseDoc: live,
        updates: [],
        hunks: [
          {
            raw: {
              insertedRanges: kind === "insertion" ? [{ client: 1, clock: 3, length: 5 }] : [],
              deletedRanges: kind === "removal" ? [{ client: 1, clock: 3, length: 5 }] : [],
              insertedText: kind === "insertion" ? "Alpha" : "",
              deletedText: kind === "removal" ? "Alpha" : "",
            },
            review: {
              kind: "text",
              hunkId: "test",
              operationIds: [],
              spans: [],
              ...(kind === "removal" ? { deletedText: "Alpha" } : {}),
              anchor: { relStart: "", relEnd: "" },
            },
          },
        ],
      });
      expect(result.hunks).toHaveLength(1);
      expect(result.hunks[0]).toMatchObject({ operationIds: [], unclassified: true, spans: [] });
      if (kind === "removal")
        expect(result.hunks[0]).toMatchObject({ deletedText: "Alpha", deletedSpans: [] });
      else expect(result.hunks[0]).toMatchObject({ insertedText: "Alpha" });
      expect(result.operations).toEqual([]);
      expect(result.diagnostics).toEqual([{ code: "unattributed_hunk", hunkId: "test" }]);
    } finally {
      live.destroy();
    }
  });

  it("covers adjacent cross-chat sentence removal and replacement without attribution gaps", () => {
    const fixture = setup(
      "Su Yin said nothing. It was a very tense moment for everyone present.\n\nEnd.",
    );
    const { draft } = fixture;
    const edits = [
      [" It was a very tense moment for everyone present.", ""],
      ["Su Yin said nothing.", "Su Yin said nothing, but her sleeve hid a drawn talisman."],
    ];
    const updates = edits.map(([find, replacement], index) => ({
      id: 901 + index,
      actorTurnId: `chat-${index}`,
      updateData: captureUpdate(draft, () => {
        const [block] = model.getBlocks(toDocHandle(draft));
        const text = model.getText(block);
        const from = text.indexOf(find);
        model.applyBlockReplacement(
          toDocHandle(draft),
          block,
          codec.parse(text.slice(0, from) + replacement + text.slice(from + find.length)).blocks[0],
        );
      }),
    }));
    const result = computeDraftReviewHunks({ ...fixture.input, draftUpdates: updates });
    expect(
      result.hunks
        .filter((h) => h.kind === "text")
        .map((h) => h.deletedText ?? "")
        .join(""),
    ).toBe(edits[0][0]);
    expect(result.hunks.find((h) => h.kind === "text" && h.deletedText)?.operationIds).toEqual([
      "901",
    ]);
    expect(result.hunks.flatMap((h) => h.operationIds)).toEqual(
      expect.arrayContaining(["901", "902"]),
    );
    for (const hunk of result.hunks) {
      if (hunk.kind !== "text" || !hunk.deletedText) continue;
      expect(hunk.deletedSpans?.reduce((length, span) => length + span.to - span.from, 0)).toBe(
        hunk.deletedText.length,
      );
    }
  });

  it("covers the full difference after consecutive cumulative paragraph deletions", () => {
    const paragraphs = ["Alpha removed.", "Beta removed.", "Gamma removed."];
    const fixture = setup([...paragraphs, "Tail remains."].join("\n\n"));
    const { draft } = fixture;
    const updates = paragraphs.map((_, index) => ({
      id: 175 + index,
      actorTurnId: `turn-${index}`,
      updateData: captureUpdate(draft, () => {
        const [first] = model.getBlocks(toDocHandle(draft));
        model.deleteBlock(toDocHandle(draft), first);
      }),
    }));
    const result = computeDraftReviewHunks({ ...fixture.input, draftUpdates: updates });
    // The union must account for every removed region, not just the first delete set.
    expect(
      result.hunks.map((hunk) =>
        hunk.kind === "text" ? hunk.deletedText : hunk.deletedBlock?.display,
      ),
    ).toEqual(paragraphs);
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["175"], ["176"], ["177"]]);
  });

  it("preserves the full diff union across mixed insertions and cumulative removals", () => {
    const removed = ["Alpha removed.", "Beta removed.", "Gamma removed."];
    const fixture = setup([...removed, "ABC remains."].join("\n\n"));
    const { draft } = fixture;
    const updates = removed.map((_, index) => ({
      id: 185 + index,
      actorTurnId: `turn-${index}`,
      updateData: captureUpdate(draft, () => {
        const [first] = model.getBlocks(toDocHandle(draft));
        model.deleteBlock(toDocHandle(draft), first);
      }),
    }));
    const [tail] = model.getBlocks(toDocHandle(draft));
    updates.push({
      id: 188,
      actorTurnId: "rewrite",
      updateData: captureUpdate(draft, () =>
        model.applyTextEdit(toDocHandle(draft), tail, { from: 0, to: 3 }, "XYZ"),
      ),
    });
    const result = computeDraftReviewHunks({ ...fixture.input, draftUpdates: updates });
    const deletionUnion = result.hunks
      .map((hunk) =>
        hunk.kind === "text" ? (hunk.deletedText ?? "") : (hunk.deletedBlock?.display ?? ""),
      )
      .join("");
    const insertionUnion = result.hunks
      .flatMap((hunk) =>
        hunk.kind === "text"
          ? hunk.spans.map((span) => {
              const position = Y.createAbsolutePositionFromRelativePosition(
                Y.decodeRelativePosition(Buffer.from(span.anchorFrom, "base64")),
                draft,
              );
              if (!position || !(position.type instanceof Y.XmlText))
                throw new Error("expected attributed text span");
              const range = spanTextRange(draft, span);
              return position.type.toString().slice(range.from, range.to);
            })
          : [hunk.insertedBlock?.display ?? ""],
      )
      .join("");
    // Independent fixture oracle for the entire difference, not merely visible operations.
    expect(deletionUnion).toBe(`${removed.join("")}ABC`);
    expect(insertionUnion).toBe("XYZ");
    expect(result.hunks.every((hunk) => hunk.operationIds.length > 0)).toBe(true);
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set(["185", "186", "187", "188"]),
    );
  });

  it("keeps writer insertions inside AI prose author-separable", () => {
    const fixture = setup("Old sentence. Tail unchanged for alignment.", [
      { id: 178, actorTurnId: "ai", edits: [[0, 0, 13, "New AI sentence."]] },
      { id: 179, actorTurnId: null, actorUserId: "writer", edits: [[0, 6, 6, "careful "]] },
    ]);
    const result = computeDraftReviewHunks(fixture.input);
    expect(result.hunks.some((hunk) => hunk.operationIds.length === 2)).toBe(true);
    expect(result.hunks.every((hunk) => !hunk.mergeArtifact)).toBe(true);
  });

  it("does not flag adjacent edits with only one removed insertion boundary", () => {
    const fixture = setup("Alpha sword remains with enough unchanged surrounding text.", [
      { id: 178, actorTurnId: "ai", edits: [[0, 11, 11, " AI"]] },
      { id: 179, actorTurnId: null, actorUserId: "writer", edits: [[0, 6, 11, ""]] },
    ]);
    const result = computeDraftReviewHunks(fixture.input);
    expect(result.hunks.every((hunk) => !hunk.mergeArtifact)).toBe(true);
  });

  it.each([
    { offset: 1, mergeArtifact: true },
    { offset: 5, mergeArtifact: false },
  ])("flags only writer typing inside text concurrently removed by AI ($offset)", ({
    offset,
    mergeArtifact,
  }) => {
    const fixture = setup("Old sentence. Tail unchanged for alignment.");
    const { live, draft } = fixture;
    const peer = cloneDoc(live);
    peers.push(peer);
    peer.clientID = 3;
    const [aiBlock] = model.getBlocks(toDocHandle(draft));
    const [writerBlock] = model.getBlocks(toDocHandle(peer));
    const ai = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), aiBlock, { from: 0, to: 13 }, "New AI sentence."),
    );
    const writer = captureUpdate(peer, () =>
      model.applyTextEdit(toDocHandle(peer), writerBlock, { from: offset, to: offset }, "careful "),
    );
    Y.applyUpdate(draft, writer);
    const result = computeDraftReviewHunks({
      ...fixture.input,
      draftUpdates: [
        { id: 178, actorTurnId: "ai", updateData: ai },
        { id: 179, actorTurnId: null, actorUserId: "writer", updateData: writer },
      ],
    });
    expect(result.hunks.some((hunk) => hunk.mergeArtifact)).toBe(mergeArtifact);
  });

  it("attributes adjacent deleted spans independently of inserted-text owners", () => {
    const fixture = setup("Alpha sword blade remains with plenty of unchanged surrounding text.", [
      { id: 178, actorTurnId: "ai", edits: [[0, 6, 12, ""]] },
      { id: 179, actorTurnId: null, actorUserId: "writer", edits: [[0, 6, 12, "new "]] },
    ]);
    const result = computeDraftReviewHunks(fixture.input);
    const hunk = result.hunks[0];
    expect(hunk).toMatchObject({
      deletedText: "sword blade",
      deletedSpans: [
        { from: 0, to: 6, deletedBy: "agent" },
        { from: 6, to: 11, deletedBy: "writer" },
      ],
    });
  });

  it("keeps source writer rows distinct inside one clock-prefix class", () => {
    const fixture = setup("Alpha. Tail text for a writer edit cluster.", [
      { id: 181, actorTurnId: null, actorUserId: "user-a", edits: [[0, 5, 5, " writer"]] },
      { id: 182, actorTurnId: null, actorUserId: "user-a", edits: [[0, 12, 12, " careful"]] },
    ]);
    const result = computeDraftReviewHunks(fixture.input);

    expect(result.operations.map((op) => op.sourceUpdateIds)).toEqual([[181], [182]]);
    expect(new Set(result.operations.map((op) => op.closureClassId)).size).toBe(1);
    expect(
      result.operations.every((op) => op.kind === "writer" && op.actorUserId === "user-a"),
    ).toBe(true);
  });

  it("keeps mixed agent and writer rows in one block as separate operations", () => {
    const fixture = setup(
      "Alpha target remains with enough unchanged surrounding text for attribution.",
      [
        { id: 211, actorTurnId: "turn-agent", edits: [[0, 6, 12, "agent"]] },
        { id: 212, actorTurnId: null, actorUserId: "user-a", edits: [[0, 11, 11, " writer"]] },
      ],
    );
    const result = computeDraftReviewHunks(fixture.input);

    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set(["211", "212"]),
    );
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "211",
        classification: "rewrite",
        beforeExcerpt: "tar",
        afterExcerpt: "a",
        sourceUpdateIds: [211],
        closureUpdateIds: [211, 212],
        actorTurnId: "turn-agent",
        kind: "agent",
      }),
      expect.objectContaining({
        operationId: "212",
        classification: "addition",
        afterExcerpt: "writer",
        sourceUpdateIds: [212],
        closureUpdateIds: [211, 212],
        actorUserId: "user-a",
        kind: "writer",
      }),
    ]);
  });

  it("emits ordered inserted sub-spans with source writer operation identities", () => {
    const fixture = setup("Alpha tail text for mixed insertion span ordering.", [
      { id: 264, actorTurnId: "turn-agent", edits: [[0, 6, 6, "green text"]] },
      { id: 265, actorTurnId: null, actorUserId: "user-a", edits: [[0, 12, 12, "gold "]] },
    ]);
    const { draft } = fixture;
    const result = computeDraftReviewHunks(fixture.input);

    const [hunk] = result.hunks;
    const writerOperation = result.operations.find((operation) => operation.kind === "writer");
    expect(writerOperation?.sourceUpdateIds).toEqual([265]);
    expect(hunk.kind).toBe("text");
    if (hunk.kind !== "text") throw new Error("expected text hunk");
    expect(writerOperation?.operationId).toBe("265");
    expect(hunk.spans.map((span) => span.operationId)).toContain("265");

    const positions = hunk.spans.map((span) => spanTextRange(draft, span));
    expect(
      positions.every((position, index) => index === 0 || positions[index - 1].to <= position.from),
    ).toBe(true);
    expect(positions.reduce((sum, position) => sum + position.to - position.from, 0)).toBe(
      "green gold text".length,
    );
  });

  it("surfaces writer edits inside unchanged-identity blocks untouched by the agent", () => {
    const fixture = setup(
      [
        "Alpha remains unchanged with enough surrounding text for review attribution.",
        "Beta target remains with enough unchanged surrounding text for agent attribution.",
        "Gamma remains unchanged with enough surrounding text for review attribution.",
        "Delta remains unchanged with enough surrounding text for writer attribution.",
      ].join("\n\n"),
      [
        { id: 241, actorTurnId: "turn-agent", edits: [[1, 11, 11, " agent"]] },
        { id: 242, actorTurnId: null, actorUserId: "user-a", edits: [[3, 5, 5, " writer"]] },
      ],
    );
    const result = computeDraftReviewHunks(fixture.input);

    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["241"], ["242"]]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "241",
        classification: "addition",
        afterExcerpt: "agent",
        sourceUpdateIds: [241],
        closureUpdateIds: [241, 242],
        actorTurnId: "turn-agent",
        kind: "agent",
      }),
      expect.objectContaining({
        operationId: "242",
        classification: "addition",
        afterExcerpt: "writer",
        sourceUpdateIds: [242],
        closureUpdateIds: [241, 242],
        actorUserId: "user-a",
        kind: "writer",
      }),
    ]);
  });

  it("drops opposite block delete/insert pairs from per-operation reject inverses", () => {
    const fixture = setup(
      [
        "Alpha remains unchanged with enough surrounding text for review attribution.",
        "- Placeholder outline beat one should be cut.",
        "- Placeholder outline beat two should be cut.",
        "Omega remains as an anchor after the restored writer block.",
      ].join("\n\n"),
    );
    const { draft } = fixture;
    const [alpha, list] = model.getBlocks(toDocHandle(draft));
    const rewrite = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), alpha, { from: 0, to: 5 }, "Beta"),
    );
    const deleteList = captureUpdate(draft, () => model.deleteBlock(toDocHandle(draft), list));
    const rejectInverseInsert = captureUpdate(draft, () =>
      model.insertBlocks(
        toDocHandle(draft),
        alpha,
        codec.parse(
          "- Placeholder outline beat one should be cut.\n- Placeholder outline beat two should be cut.",
        ),
      ),
    );

    const result = computeDraftReviewHunks({
      ...fixture.input,
      draftUpdates: [
        { id: 266, actorTurnId: "turn-rewrite", updateData: rewrite },
        { id: 267, actorTurnId: "turn-delete-list", updateData: deleteList },
        { id: 268, actorTurnId: null, actorUserId: "user-a", updateData: rejectInverseInsert },
      ],
    });

    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ kind: "text", operationIds: ["266"] });
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "266",
        classification: "rewrite",
      }),
    ]);
  });
});
