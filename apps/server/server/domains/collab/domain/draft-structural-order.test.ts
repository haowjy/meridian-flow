/** Structural revisions preserve exact manuscript order and independently replayable components. */
import {
  createAgentEditCodecFactory,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { createSemanticProvenanceWriter } from "./provenance.js";

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);

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
  for (const ids of classes.values()) {
    const peer = new Y.Doc({ gc: false });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
    for (const row of rows.filter((row) => ids.some((id) => id === row.id)))
      Y.applyUpdate(peer, row.updateData);
    expect(peer.store.pendingStructs).toBeNull();
    expect(peer.store.pendingDs).toBeNull();
    const nodes = model.projectBlocks(toDocHandle(peer));
    for (const node of nodes) node.check();
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
    const result = await revision(before, blocks.join("\n\n"), draft);
    for (const nodes of result.isolated) {
      const text = nodes.map((node) => node.textContent).join("\n\n");
      // A structural component may not lose or duplicate an original sentence.
      for (const marker of markers)
        expect(
          [...text.matchAll(new RegExp(`\\b${marker}\\b`, "g"))],
          `sample ${sample}: ${marker}`,
        ).toHaveLength(1);
    }
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
    for (const nodes of result.isolated) {
      const text = nodes.map((node) => node.textContent).join(" ");
      for (const marker of ["Alpha", "Beta", "Gamma", "Delta"])
        expect([...text.matchAll(new RegExp(`\\b${marker}\\b`, "g"))]).toHaveLength(1);
    }
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
