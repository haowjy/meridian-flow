/** Real-Yjs coverage for draft live-vs-draft hunk extraction and attribution. */
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { computeDraftReviewOperations } from "./draft-review-operations.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });
const model = yProsemirrorModel(schema);

const WRITER_OPERATION_ID = /^writer:\d+-[a-f0-9]+$/;

describe("draft review hunk model", () => {
  it("extracts word-level changed-block hunks anchored in the draft doc", () => {
    const live = createDoc(
      "Alpha sword. This paragraph has enough unchanged surrounding text for inline review.\n\nBeta stays.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 11 }, "blade"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 10, actorTurnId: "turn-a", updateData: update }],
    });

    expect(result).toHaveProperty("operations");
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({ operationIds: ["10"], deletedText: "sword" });
    expect(result.hunks[0].anchor.relStart).toEqual(expect.any(String));
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "10",
        contribution: "rewrote",
        classification: "rewrite",
        beforeExcerpt: "sword",
        afterExcerpt: "blade",
        sourceUpdateIds: [10],
        closureUpdateIds: [10],
        actorTurnId: "turn-a",
        kind: "agent",
        hunkCount: 1,
      }),
    ]);
  });

  it("attributes deleted live text to the row whose delete set covers it", () => {
    const live = createDoc(
      "Alpha sword remains with enough unchanged surrounding text for inline review density.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 12 }, ""),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 21, actorTurnId: "turn-delete", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks).toEqual([
      expect.objectContaining({ operationIds: ["21"], deletedText: "sword " }),
    ]);
  });

  it("keeps one row that genuinely deletes two regions linked to both hunks", () => {
    const live = createDoc(
      [
        "Alpha target remains with enough unchanged surrounding text for attribution.",
        "Beta target remains with enough unchanged surrounding text for attribution.",
        "Gamma stays unchanged with enough surrounding text for attribution.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [first, second] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 13 }, "");
      model.applyTextEdit(toDocHandle(draft), second, { from: 5, to: 12 }, "");
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 171, actorTurnId: "turn-two-deletions", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["171"], ["171"]]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "171",
        contribution: "removed",
        classification: "removal",
        beforeExcerpt: "target",
        sourceUpdateIds: [171],
        closureUpdateIds: [171],
        actorTurnId: "turn-two-deletions",
        kind: "agent",
        hunkCount: 2,
      }),
    ]);
  });

  it.each([
    { label: "shared client", adjacentRewrite: false, freshPeers: false },
    { label: "shared client with adjacent rewrite", adjacentRewrite: true, freshPeers: false },
    { label: "fresh chat peers (reported operation 72)", adjacentRewrite: false, freshPeers: true },
  ])("publishes every class and its preview complement ($label)", ({
    adjacentRewrite,
    freshPeers,
  }) => {
    const base = [
      "Elder Mo raised his hand, and the courtyard fell silent.",
      "Su Yin said nothing. It was a very tense moment for everyone present.",
      "The outer disciples stepped back, and even the inner disciples looked away.",
      "The mountain stayed still.",
      "The river kept flowing.",
    ].join("\n\n");
    const live = createDoc(base);
    const draft = cloneDoc(live);
    const edits = [
      { id: 69, block: 0, find: "his", replacement: "" },
      {
        id: 71,
        block: 1,
        find: " It was a very tense moment for everyone present.",
        replacement: "",
      },
      {
        id: 72,
        block: 0,
        find: "fell silent.",
        replacement: "fell silent. Lin Feng felt the qi coil.",
      },
      { id: 74, block: 3, find: "stayed still.", replacement: "stayed still. A bell rang." },
      { id: 75, block: 2, find: "stepped back", replacement: "fell back to their knees" },
    ];
    if (adjacentRewrite)
      edits.push({
        id: 77,
        block: 1,
        find: "Su Yin said nothing.",
        replacement: "Su Yin said nothing, but her sleeve hid a drawn talisman.",
      });
    const updates = edits.map((edit) => ({
      id: edit.id,
      actorTurnId: `turn-${edit.id}`,
      updateData: captureUpdate(draft, () => {
        if (freshPeers) draft.clientID = 10 + edit.id;
        const block = model.getBlocks(toDocHandle(draft))[edit.block];
        const from = model.getText(block).indexOf(edit.find);
        model.applyBlockReplacement(
          toDocHandle(draft),
          block,
          codec.parse(model.getText(block).replace(edit.find, edit.replacement)).blocks[0],
        );
        expect(from).toBeGreaterThanOrEqual(0);
      }),
    }));
    // A fresh peer's transaction delta has no cumulative branch deletes and
    // stays independently selectable, unlike the shared client's clock prefix.
    const independent = { id: 76, block: 4, find: "flowing", replacement: "flowing north" };
    edits.push(independent);
    const peer = cloneDoc(draft);
    peer.clientID = 3;
    let delta: Uint8Array | undefined;
    peer.on("update", (update) => {
      delta = update;
    });
    const river = model.getBlocks(toDocHandle(peer))[4];
    model.applyTextEdit(toDocHandle(peer), river, { from: 22, to: 22 }, " north");
    if (!delta) throw new Error("missing independent update");
    Y.applyUpdate(draft, delta);
    updates.push({ id: 76, actorTurnId: "turn-76", updateData: delta });
    peer.destroy();
    const preview = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: updates,
    });
    const classes = new Set(preview.operations.map((op) => op.closureClassId));
    expect(classes.size).toBeGreaterThan(1);
    // Exercise the reported later insertion first, then every other class.
    const reportedClass = preview.operations.find((op) => op.operationId === "72")?.closureClassId;
    for (const classId of [...classes].sort(
      (a, b) => Number(b === reportedClass) - Number(a === reportedClass),
    )) {
      const selected = preview.operations.filter((op) => op.closureClassId === classId);
      const ids = new Set(selected.map((op) => op.operationId));
      const rowIds = new Set<number>(selected.flatMap((op) => op.closureUpdateIds));
      const applied = cloneDoc(live);
      applied.clientID = 4;
      for (const row of updates.filter((row) => rowIds.has(row.id)))
        Y.applyUpdate(applied, row.updateData);
      let expected = base;
      for (const edit of edits.filter((edit) => ids.has(String(edit.id))))
        expected = expected.replace(edit.find, edit.replacement);
      expect(
        model
          .getBlocks(toDocHandle(applied))
          .map((block) => model.getText(block))
          .join("\n\n"),
        classId,
      ).toBe(expected);
      const remaining = computeDraftReviewHunks({
        liveDoc: applied,
        draftDoc: draft,
        model,
        draftUpdates: updates.filter((row) => !rowIds.has(row.id)),
      });
      const signature = (hunks: typeof preview.hunks) =>
        hunks.map((hunk) => ({
          ids: hunk.operationIds,
          deleted: hunk.kind === "text" ? hunk.deletedText : hunk.deletedBlock?.display,
          inserted:
            hunk.kind === "text"
              ? hunk.spans
                  .map((span) => {
                    const position = Y.createAbsolutePositionFromRelativePosition(
                      Y.decodeRelativePosition(Buffer.from(span.anchorFrom, "base64")),
                      draft,
                    );
                    if (!position || !(position.type instanceof Y.XmlText))
                      throw new Error("missing span");
                    const range = spanTextRange(draft, span);
                    return position.type.toString().slice(range.from, range.to);
                  })
                  .join("")
              : hunk.insertedBlock?.display,
        }));
      const published = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: applied,
        model,
        draftUpdates: updates.filter((row) => rowIds.has(row.id)),
      });
      expect(signature(published.hunks), classId).toEqual(
        signature(preview.hunks.filter((hunk) => hunk.operationIds.some((id) => ids.has(id)))),
      );
      expect(signature(remaining.hunks), classId).toEqual(
        signature(preview.hunks.filter((hunk) => !hunk.operationIds.some((id) => ids.has(id)))),
      );
      applied.destroy();
    }
    draft.destroy();
    live.destroy();
  });

  it("keeps an unattributed removal beside an attributed insertion and reports the gap", () => {
    const live = createDoc("Alpha stays.");
    const draft = cloneDoc(live);
    const block = model.getBlocks(toDocHandle(draft))[0];
    const updateData = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), block, { from: 0, to: 0 }, "New "),
    );
    const insertedRanges = Y.decodeUpdate(updateData).structs.map((item) => ({
      ...item.id,
      length: item.length,
    }));
    try {
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
              blockKey: "test",
              blockIndex: 0,
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
    } finally {
      draft.destroy();
      live.destroy();
    }
  });

  it("keeps the full partly attributed removal rather than only its known author spans", () => {
    const live = createDoc("Alpha stays.");
    const draft = cloneDoc(live);
    try {
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
              blockKey: "test",
              blockIndex: 0,
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
    } finally {
      draft.destroy();
      live.destroy();
    }
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
              blockKey: "test",
              blockIndex: 0,
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
    const live = createDoc(
      "Su Yin said nothing. It was a very tense moment for everyone present.\n\nEnd.",
    );
    const draft = cloneDoc(live);
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
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: updates,
    });
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
    const live = createDoc([...paragraphs, "Tail remains."].join("\n\n"));
    const draft = cloneDoc(live);
    const updates = paragraphs.map((_, index) => ({
      id: 175 + index,
      actorTurnId: `turn-${index}`,
      updateData: captureUpdate(draft, () => {
        const [first] = model.getBlocks(toDocHandle(draft));
        model.deleteBlock(toDocHandle(draft), first);
      }),
    }));
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: updates,
    });
    // The union must account for every removed region, not just the first delete set.
    expect(
      result.hunks.map((hunk) =>
        hunk.kind === "text" ? hunk.deletedText : hunk.deletedBlock?.display,
      ),
    ).toEqual(paragraphs);
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["175"], ["176"], ["177"]]);
    expect(result.wordDelta).toEqual({ wordsAdded: 0, wordsRemoved: 6 });
  });

  it("preserves the full diff union across mixed insertions and cumulative removals", () => {
    const removed = ["Alpha removed.", "Beta removed.", "Gamma removed."];
    const live = createDoc([...removed, "ABC remains."].join("\n\n"));
    const draft = cloneDoc(live);
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
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: updates,
    });
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
    const live = createDoc("Old sentence. Tail unchanged for alignment.");
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const ai = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 0, to: 13 }, "New AI sentence."),
    );
    const writer = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 6 }, "careful "),
    );
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 178, actorTurnId: "ai", updateData: ai },
        { id: 179, actorTurnId: null, actorUserId: "writer", updateData: writer },
      ],
    });
    expect(result.hunks.some((hunk) => hunk.operationIds.length === 2)).toBe(true);
    expect(result.hunks.every((hunk) => !hunk.mergeArtifact)).toBe(true);
  });

  it("does not flag adjacent edits with only one removed insertion boundary", () => {
    const live = createDoc("Alpha sword remains with enough unchanged surrounding text.");
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const ai = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 11, to: 11 }, " AI"),
    );
    const writer = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 11 }, ""),
    );
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 178, actorTurnId: "ai", updateData: ai },
        { id: 179, actorTurnId: null, actorUserId: "writer", updateData: writer },
      ],
    });
    expect(result.hunks.every((hunk) => !hunk.mergeArtifact)).toBe(true);
  });

  it("flags writer typing into a sentence concurrently rewritten by AI", () => {
    const live = createDoc("Old sentence. Tail unchanged for alignment.");
    const draft = cloneDoc(live);
    const peer = cloneDoc(live);
    peer.clientID = 3;
    const [aiBlock] = model.getBlocks(toDocHandle(draft));
    const [writerBlock] = model.getBlocks(toDocHandle(peer));
    const ai = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), aiBlock, { from: 0, to: 13 }, "New AI sentence."),
    );
    const writer = captureUpdate(peer, () =>
      model.applyTextEdit(toDocHandle(peer), writerBlock, { from: 5, to: 5 }, "careful "),
    );
    Y.applyUpdate(draft, writer);
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 178, actorTurnId: "ai", updateData: ai },
        { id: 179, actorTurnId: null, actorUserId: "writer", updateData: writer },
      ],
    });
    expect(result.hunks.some((hunk) => hunk.mergeArtifact)).toBe(true);
  });

  it("attributes adjacent deleted spans independently of inserted-text owners", () => {
    const live = createDoc("Alpha sword blade remains with plenty of unchanged surrounding text.");
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const ai = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 12 }, ""),
    );
    const writer = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 12 }, "new "),
    );
    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 178, actorTurnId: "ai", updateData: ai },
        { id: 179, actorTurnId: null, actorUserId: "writer", updateData: writer },
      ],
    });
    const hunk = result.hunks[0];
    expect(hunk).toMatchObject({
      deletedText: "sword blade",
      deletedSpans: [
        { from: 0, to: 6, deletedBy: "agent" },
        { from: 6, to: 11, deletedBy: "writer" },
      ],
    });
  });

  it("clusters writer rows in the same block into one writer operation", () => {
    const live = createDoc("Alpha. Tail text for a writer edit cluster.");
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const firstUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 5, to: 5 }, " writer"),
    );
    const secondUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 12, to: 12 }, " careful"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 181, actorTurnId: null, actorUserId: "user-a", updateData: firstUpdate },
        { id: 182, actorTurnId: null, actorUserId: "user-a", updateData: secondUpdate },
      ],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 181);
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set([writerOperationId]),
    );
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "added",
        classification: "addition",
        afterExcerpt: "writer careful",
        sourceUpdateIds: [181, 182],
        closureUpdateIds: [181, 182],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: result.hunks.length,
      }),
    ]);
  });

  it("keeps mixed agent and writer rows in one block as separate operations", () => {
    const live = createDoc(
      "Alpha target remains with enough unchanged surrounding text for attribution.",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const agentUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 12 }, "agent"),
    );
    const writerUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 11, to: 11 }, " writer"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 211, actorTurnId: "turn-agent", updateData: agentUpdate },
        { id: 212, actorTurnId: null, actorUserId: "user-a", updateData: writerUpdate },
      ],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 212);
    expect(new Set(result.hunks.flatMap((hunk) => hunk.operationIds))).toEqual(
      new Set(["211", writerOperationId]),
    );
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "211",
        contribution: "rewrote",
        classification: "rewrite",
        beforeExcerpt: "target",
        afterExcerpt: "agent writer",
        sourceUpdateIds: [211],
        closureUpdateIds: [211, 212],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      }),
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "added",
        classification: "rewrite",
        beforeExcerpt: "target",
        afterExcerpt: "agent writer",
        sourceUpdateIds: [212],
        closureUpdateIds: [211, 212],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      }),
    ]);
  });

  it("classifies a repeated before-after pair across three regions as a rename", () => {
    const live = createDoc(
      [
        "Chen raised the sword with enough surrounding text for review.",
        "Chen crossed the bridge with enough surrounding text for review.",
        "Chen opened the gate with enough surrounding text for review.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const blocks = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      for (const block of blocks) {
        model.applyTextEdit(toDocHandle(draft), block, { from: 0, to: 4 }, "Li Wei");
      }
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 261, actorTurnId: "turn-ai-7", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "261",
        actorTurnId: "turn-ai-7",
        classification: "rename",
        beforeExcerpt: "Chen",
        afterExcerpt: "Li Wei",
        hunkCount: 3,
      }),
    ]);
  });

  it("emits ordered inserted sub-spans remapped to stable writer operation ids", () => {
    const live = createDoc("Alpha tail text for mixed insertion span ordering.");
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const agentUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 6, to: 6 }, "green text"),
    );
    const writerUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 12, to: 12 }, "gold "),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 264, actorTurnId: "turn-agent", updateData: agentUpdate },
        { id: 265, actorTurnId: null, actorUserId: "user-a", updateData: writerUpdate },
      ],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const [hunk] = result.hunks;
    const writerOperation = result.operations.find((operation) => operation.kind === "writer");
    expect(writerOperation?.operationId).toMatch(/^writer:265-/);
    expect(hunk.kind).toBe("text");
    if (hunk.kind !== "text") throw new Error("expected text hunk");
    expect(hunk.spans.map((span) => span.operationId)).toContain(writerOperation?.operationId);

    const positions = hunk.spans.map((span) => spanTextRange(draft, span));
    expect(
      positions.every((position, index) => index === 0 || positions[index - 1].to <= position.from),
    ).toBe(true);
    expect(positions.reduce((sum, position) => sum + position.to - position.from, 0)).toBe(
      "green gold text".length,
    );
  });

  it("surfaces writer edits inside unchanged-identity blocks untouched by the agent", () => {
    const live = createDoc(
      [
        "Alpha remains unchanged with enough surrounding text for review attribution.",
        "Beta target remains with enough unchanged surrounding text for agent attribution.",
        "Gamma remains unchanged with enough surrounding text for review attribution.",
        "Delta remains unchanged with enough surrounding text for writer attribution.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
    const [, second, , fourth] = model.getBlocks(toDocHandle(draft));
    const agentUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), second, { from: 11, to: 11 }, " agent"),
    );
    const writerUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), fourth, { from: 5, to: 5 }, " writer"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 241, actorTurnId: "turn-agent", updateData: agentUpdate },
        { id: 242, actorTurnId: null, actorUserId: "user-a", updateData: writerUpdate },
      ],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");
    const writerOperationId = writerOperationIdForRow(result.operations, 242);
    expect(result.hunks.map((hunk) => hunk.operationIds)).toEqual([["241"], [writerOperationId]]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "241",
        contribution: "added",
        classification: "addition",
        afterExcerpt: "agent",
        sourceUpdateIds: [241],
        closureUpdateIds: [241, 242],
        actorTurnId: "turn-agent",
        kind: "agent",
        hunkCount: 1,
      }),
      expect.objectContaining({
        operationId: writerOperationId,
        contribution: "added",
        classification: "addition",
        afterExcerpt: "writer",
        sourceUpdateIds: [242],
        closureUpdateIds: [241, 242],
        actorUserId: "user-a",
        kind: "writer",
        hunkCount: 1,
      }),
    ]);
  });

  it("drops opposite block delete/insert pairs from per-operation reject inverses", () => {
    const live = createDoc(
      [
        "Alpha remains unchanged with enough surrounding text for review attribution.",
        "- Placeholder outline beat one should be cut.",
        "- Placeholder outline beat two should be cut.",
        "Omega remains as an anchor after the restored writer block.",
      ].join("\n\n"),
    );
    const draft = cloneDoc(live);
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
      liveDoc: live,
      draftDoc: draft,
      model,
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
        contribution: "rewrote",
        classification: "rewrite",
        hunkCount: 1,
      }),
    ]);
  });

  it("emits a block replace hunk for list edits", () => {
    const live = createDoc(
      "- sword item with enough surrounding list text for block hunk attribution",
    );
    const draft = cloneDoc(live);
    const [first] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), first, { from: 2, to: 7 }, "blade"),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 55, actorTurnId: "turn-list", updateData: update }],
    });

    expect(result.hunks).toEqual([
      expect.objectContaining({
        kind: "block",
        operationIds: ["55"],
        deletedBlock: {
          type: "bullet_list",
          display: "sword item with enough surrounding list text for block hunk attribution",
        },
        insertedBlock: {
          type: "bullet_list",
          display: "swbladetem with enough surrounding list text for block hunk attribution",
        },
      }),
    ]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        operationId: "55",
        contribution: "rewrote",
        classification: "rewrite",
        hunkCount: 1,
      }),
    ]);
  });

  it("allows text and block hunks to coexist", () => {
    const live = createDoc("Alpha sword.\n\nOmega.");
    const draft = cloneDoc(live);
    const [alpha] = model.getBlocks(toDocHandle(draft));
    const textUpdate = captureUpdate(draft, () =>
      model.applyTextEdit(toDocHandle(draft), alpha, { from: 6, to: 11 }, "blade"),
    );
    const ruleUpdate = captureUpdate(draft, () =>
      model.insertBlocks(toDocHandle(draft), alpha, codec.parse("---")),
    );

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [
        { id: 58, actorTurnId: "turn-text", updateData: textUpdate },
        { id: 59, actorTurnId: "turn-block", updateData: ruleUpdate },
      ],
    });

    expect(result.hunks.map((hunk) => hunk.kind)).toEqual(["text", "block"]);
    expect(result.hunks[0]).toMatchObject({ kind: "text", operationIds: ["58"] });
    expect(result.hunks[1]).toMatchObject({
      kind: "block",
      operationIds: ["59"],
      insertedBlock: { type: "horizontal_rule", display: "───" },
    });
  });

  it("keeps paragraph moves inline as delete and insert hunks", () => {
    const live = createDoc("One paragraph.\n\nTwo paragraph.\n\nThree paragraph.");
    const draft = cloneDoc(live);
    const [, two, three] = model.getBlocks(toDocHandle(draft));
    const update = captureUpdate(draft, () => {
      model.deleteBlock(toDocHandle(draft), two);
      model.insertBlocks(toDocHandle(draft), three, codec.parse("Two paragraph."));
    });

    const result = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [{ id: 53, actorTurnId: "turn-move", updateData: update }],
    });

    expect("operations" in result).toBe(true);
    if (!("operations" in result)) throw new Error("expected inline result");

    expect(
      result.hunks.some((hunk) => hunk.kind === "text" && hunk.deletedText === "Two paragraph."),
    ).toBe(true);
    expect(
      result.hunks.some(
        (hunk) => hunk.kind === "text" && !hunk.deletedText && hunk.operationIds.length > 0,
      ),
    ).toBe(true);
  });
});

function writerOperationIdForRow(
  operations: readonly { operationId: string; kind: string }[],
  rowId: number,
): string {
  const match = operations.find(
    (operation) =>
      operation.kind === "writer" && new RegExp(`^writer:${rowId}-`).test(operation.operationId),
  );
  expect(match?.operationId).toMatch(WRITER_OPERATION_ID);
  if (!match) throw new Error(`missing writer operation for row ${rowId}`);
  return match.operationId;
}

function createDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const parsed = codec.parse(markdown);
  const root = schema.node("doc", null, parsed.blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function captureUpdate(doc: Y.Doc, mutate: () => void): Uint8Array {
  const before = Y.encodeStateVector(doc);
  mutate();
  return Y.encodeStateAsUpdate(doc, before);
}

function spanTextRange(
  doc: Y.Doc,
  span: { anchorFrom: string; anchorTo: string },
): { from: number; to: number } {
  const from = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Buffer.from(span.anchorFrom, "base64")),
    doc,
  );
  const to = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Buffer.from(span.anchorTo, "base64")),
    doc,
  );
  if (!from || !to || from.type !== to.type) throw new Error("expected span in one text node");
  return { from: from.index, to: to.index };
}
