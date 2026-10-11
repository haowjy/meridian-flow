/** Structural revisions preserve exact manuscript order and independently replayable components. */
import {
  createAgentEditCodecFactory,
  toDocHandle,
  unwrapBlock,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import type { ReviewHunk } from "@meridian/contracts/drafts";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { createSemanticProvenanceWriter } from "./provenance.js";

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);

function expectDisplayHonesty(live: Y.Doc, peer: Y.Doc, hunks: ReviewHunk[]) {
  const baseRefs = model.getBlocks(toDocHandle(live));
  const base = baseRefs.map((block) => model.getText(block));
  const baseIds = new Set(baseRefs.map((block) => model.getBlockId(block)));
  const blocks = model.getBlocks(toDocHandle(peer));
  const target = blocks.map((block) => model.getText(block));
  const resolve = (anchor: string) => {
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Buffer.from(anchor, "base64")),
      peer,
    );
    if (!position) throw new Error("Unresolved display anchor");
    return position;
  };
  const edits = hunks
    .map((hunk, order) => {
      const from = resolve(hunk.anchor.relStart),
        to = resolve(hunk.anchor.relEnd);
      if (hunk.kind === "block")
        return {
          kind: "block" as const,
          block: from.index,
          order,
          inserted: hunk.insertedBlock?.display,
          deleted: hunk.deletedBlock?.display,
        };
      if (from.type instanceof Y.XmlFragment && !(from.type instanceof Y.XmlText))
        return {
          kind: "block" as const,
          block: from.index,
          order,
          inserted: undefined,
          deleted: hunk.deletedText,
        };
      const block = blocks.findIndex((ref) => unwrapBlock(ref) === from.type.parent);
      expect(block).toBeGreaterThanOrEqual(0);
      const inserted =
        hunk.spans
          .map((span) => {
            const start = resolve(span.anchorFrom),
              end = resolve(span.anchorTo);
            expect(start.type).toBe(end.type);
            return (start.type as Y.XmlText).toString().slice(start.index, end.index);
          })
          .join("") ||
        hunk.insertedText ||
        "";
      if (!baseIds.has(model.getBlockId(blocks[block]))) {
        expect(inserted).toBe(target[block]);
        return { kind: "block" as const, block, order, inserted, deleted: undefined };
      }
      expect(target[block].slice(from.index, to.index)).toBe(inserted);
      return {
        kind: "text" as const,
        block,
        order,
        from: from.index,
        to: to.index,
        inserted,
        deleted: hunk.deletedText ?? "",
      };
    })
    .sort(
      (a, b) =>
        b.block - a.block ||
        (b.kind === "text" ? b.from : 0) - (a.kind === "text" ? a.from : 0) ||
        b.order - a.order,
    );
  const displayed = [...target];
  // Reverse the shown effects to locate their base positions, then apply exactly
  // those same displayed edits forward. No Yjs updates participate in either pass.
  for (const edit of edits) {
    if (edit.kind === "block")
      displayed.splice(
        edit.block,
        edit.inserted === undefined ? 0 : 1,
        ...(edit.deleted === undefined ? [] : [edit.deleted]),
      );
    else
      displayed[edit.block] =
        displayed[edit.block].slice(0, edit.from) +
        edit.deleted +
        displayed[edit.block].slice(edit.to);
  }
  expect(displayed).toEqual(base);
  for (const edit of [...edits].reverse()) {
    if (edit.kind === "block")
      displayed.splice(
        edit.block,
        edit.deleted === undefined ? 0 : 1,
        ...(edit.inserted === undefined ? [] : [edit.inserted]),
      );
    else
      displayed[edit.block] =
        displayed[edit.block].slice(0, edit.from) +
        edit.inserted +
        displayed[edit.block].slice(edit.from + edit.deleted.length);
  }
  expect(displayed).toEqual(target);
}

async function revision(before: string, after: string, draft: boolean) {
  const h = createWriteToolHarness(
    { "chapter.md": before },
    { segmentDraftWrites: draft, semanticProvenance: createSemanticProvenanceWriter() },
  );
  const live = new Y.Doc({ gc: false });
  Y.applyUpdate(live, Y.encodeStateAsUpdate(h.liveDoc("chapter.md")));
  const result = await h.core.write(
    {
      command: "replace",
      file: "chapter.md",
      in: [1, codec.parse(before).blocks.length],
      content: after,
    },
    { sessionId: "chat", threadId: "chat", turnId: "revision" },
  );
  expect(result.result.status).toBe("success");
  const doc = h.liveDoc("chapter.md");
  const projected = model.projectBlocks(toDocHandle(doc));
  const expected = codec.parse(after).blocks;
  expect(projected.map((node) => node.toJSON())).toEqual(expected.map((node) => node.toJSON()));
  expect(projected.every((node, index) => node.eq(expected[index]))).toBe(true);
  for (const node of projected) node.check();
  const rows = (await h.journal.readForReconstruction("chapter.md")).updates.map((row) => ({
    id: row.seq,
    actorTurnId: row.meta.actorTurnId ?? null,
    updateData: row.update,
  }));
  const review = computeDraftReviewHunks({
    liveDoc: live,
    draftDoc: doc,
    model,
    draftUpdates: rows,
  });
  const classes = new Map(review.operations.map((op) => [op.closureClassId, op.closureUpdateIds]));
  const isolated = [];
  for (const [classId, ids] of classes) {
    const peer = new Y.Doc({ gc: false });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    for (const row of rows.filter((row) => ids.some((id) => id === row.id)))
      Y.applyUpdate(peer, row.updateData);
    expect(peer.store.pendingStructs).toBeNull();
    expect(peer.store.pendingDs).toBeNull();
    const nodes = model.projectBlocks(toDocHandle(peer));
    for (const node of nodes) node.check();
    const operationIds = new Set(
      review.operations.filter((op) => op.closureClassId === classId).map((op) => op.operationId),
    );
    expectDisplayHonesty(
      live,
      peer,
      review.hunks.filter((hunk) => hunk.operationIds.some((id) => operationIds.has(id))),
    );
    isolated.push(nodes);
    peer.destroy();
  }
  live.destroy();
  return { isolated, classes, expected };
}

it.each([
  false,
  true,
])("preserves split and new-paragraph order on both sides (draft=%s)", async (draft) => {
  const before = "Alpha road. Beta valley.";
  for (const after of [
    "Alpha road.\n\nBeta dark valley.\n\nEntirely new story.\n\nAnother new story.",
    "Entirely new story.\n\nAlpha road.\n\nBeta dark valley.\n\nAnother new story.",
    "Alpha road.\n\nEntirely new story.\n\nBeta dark valley.\n\nAnother new story.",
  ])
    await revision(before, after, draft);
});

it.each([
  false,
  true,
])("unions overlapping split/merge boundaries and replays the connected change alone (draft=%s)", async (draft) => {
  const result = await revision(
    "Alpha road. Beta valley.\n\nGamma sea. Delta hill.",
    "Alpha road.\n\nBeta valley. Gamma sea.\n\nDelta hill.",
    draft,
  );
  expect(result.classes.size).toBe(1);
  expect(result.isolated).toHaveLength(1);
  expect(result.isolated[0].map((node) => node.toJSON())).toEqual(
    result.expected.map((node) => node.toJSON()),
  );
});

it.each([
  false,
  true,
])("preserves randomized split/merge/insertion order and each isolated class (draft=%s)", async (draft) => {
  // Reproducible bounded property sample: regroup ordered sentences and insert new blocks.
  let state = 0x713;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let sample = 0; sample < 24; sample++) {
    const markers = Array.from({ length: 8 }, (_, index) => `Orchid${sample}x${index}`);
    const sentences = markers.map((marker) => `${marker} walks the valley.`);
    const before = Array.from({ length: 4 }, (_, index) =>
      sentences.slice(index * 2, index * 2 + 2).join(" "),
    ).join("\n\n");
    const blocks = [];
    for (let index = 0; index < sentences.length; ) {
      if (random() < 0.4) blocks.push(`Entirely new Story${sample}x${index} opens here.`);
      const count = 1 + Math.floor(random() * 3);
      blocks.push(
        sentences
          .slice(index, index + count)
          .map((sentence) => (random() < 0.3 ? sentence.replace("walks", "crosses") : sentence))
          .join(" "),
      );
      index += count;
    }
    if (random() < 0.5) blocks.push(`Entirely new Ending${sample} waits here.`);
    await revision(before, blocks.join("\n\n"), draft);
  }
});

it.each([
  false,
  true,
])("keeps independent split components separate across adjacent or kept blocks (draft=%s)", async (draft) => {
  for (const sentinel of ["", "\n\nUntouched mountain."]) {
    const before = `Alpha road. Beta valley.${sentinel}\n\nGamma sea. Delta hill.`;
    const after = `Alpha road.\n\nBeta dark valley.${sentinel}\n\nGamma sea.\n\nDelta green hill.`;
    const result = await revision(before, after, draft);
    expect(result.classes.size).toBe(draft ? 2 : 1);
  }
});

it("keeps generated cross-paragraph common-word substitutions independently replayable", async () => {
  for (let sample = 0; sample < 12; sample++) {
    const before = [`Alpha${sample} takes the sword.`, `Beta${sample} drops a shield.`];
    const after = [`Alpha${sample} takes a sword.`, `Beta${sample} drops the shield.`];
    const result = await revision(before.join("\n\n"), after.join("\n\n"), true);
    expect(result.classes.size, `sample ${sample}`).toBe(2);
    expect(
      result.isolated.map((nodes) => nodes.map((node) => node.textContent).join("\n\n")).sort(),
    ).toEqual([[after[0], before[1]].join("\n\n"), [before[0], after[1]].join("\n\n")].sort());
  }
});

it.each([
  false,
  true,
])("retains count-changing sentence splits as one exact change (draft=%s)", async (draft) => {
  for (const [oldCount, newCount] of [
    [1, 2],
    [1, 3],
    [2, 1],
    [3, 2],
  ]) {
    const result = await revision(
      `Alpha road. ${Array(oldCount).fill("Beta valley.").join(" ")}`,
      `Alpha road.\n\n${Array(newCount).fill("Beta valley.").join(" ")}`,
      draft,
    );
    expect(result.classes.size).toBe(1);
    expect(result.isolated[0].map((node) => node.toJSON())).toEqual(
      result.expected.map((node) => node.toJSON()),
    );
  }
});

it.each([
  false,
  true,
])("retains no-space word and single-token grapheme splits (draft=%s)", async (draft) => {
  for (const [before, after] of [
    ["青山绿水", "青山\n\n绿水"],
    ["abcdef", "abc\n\ndef"],
  ]) {
    const result = await revision(before, after, draft);
    expect(result.classes.size).toBe(1);
    expect(result.isolated[0].map((node) => node.toJSON())).toEqual(
      result.expected.map((node) => node.toJSON()),
    );
  }
});

it.each([
  false,
  true,
])("recognizes compatible word, punctuation and emoji boundary tokenization (draft=%s)", async (draft) => {
  for (const [before, after] of [
    ["Alpha Beta", "Alpha\n\nBeta"],
    ["Alpha Beta.", "Alpha\n\nBeta."],
    ["👩‍🚀 Hello", "👩‍🚀\n\nHello"],
  ]) {
    const result = await revision(before, after, draft);
    expect(result.classes.size).toBe(1);
    expect(result.isolated[0].map((node) => node.toJSON())).toEqual(
      result.expected.map((node) => node.toJSON()),
    );
  }
});

it("keeps generated repeated-phrase substitutions in paired paragraphs independent", async () => {
  for (let sample = 0; sample < 8; sample++) {
    const phrase = `under the ancient mountain the silver river wandered ${sample}`;
    const result = await revision(
      `Alpha takes ${phrase} sword.\n\nBeta drops a shield. Again ${phrase}.`,
      `Alpha takes a sword.\n\nBeta drops ${phrase} shield. Again ${phrase}.`,
      true,
    );
    expect(result.classes.size).toBe(2);
  }
});

it("recognizes generated pure multi-way splits and merges as one change", async () => {
  for (let sample = 0; sample < 8; sample++) {
    const paragraphs = Array.from(
      { length: 2 + (sample % 4) },
      (_, i) => `Orchid${sample}x${i} walks through a valley.`,
    );
    for (const [before, after] of [
      [paragraphs.join(" "), paragraphs.join("\n\n")],
      [paragraphs.join("\n\n"), paragraphs.join(" ")],
    ]) {
      const result = await revision(before, after, true);
      expect(result.classes.size).toBe(1);
    }
  }
});

it("conservatively joins structural windows beyond the character budget", async () => {
  for (const text of ["long ".repeat(850)]) {
    const result = await revision(
      `${text}ending.`,
      `${text}changed.\n\nEntirely unrelated addition.`,
      true,
    );
    expect(result.classes.size).toBe(1);
  }
});

it.each([
  false,
  true,
])("joins three-way subword and repeated-word splits and reverse merges (draft=%s)", async (draft) => {
  for (const [whole, parts] of [
    ["abcdefghijkl", ["abc", "de", "fghijkl"]],
    ["abcdefghijkl", ["abcdefg", "hi", "jkl"]],
    ["青山绿水长河天地", ["青山", "绿水", "长河天地"]],
    ["one two one three four five six", ["one two", "one", "three four five six"]],
    ["one two three four five one six", ["one two three four five", "one", "six"]],
  ] as const) {
    for (const [before, after] of [
      [whole, parts.join("\n\n")],
      [parts.join("\n\n"), whole],
    ]) {
      const result = await revision(before, after, draft);
      expect(result.classes.size).toBe(1);
    }
  }
});
