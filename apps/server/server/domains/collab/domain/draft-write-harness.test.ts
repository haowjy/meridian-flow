/** Consolidated test contracts; each block retains its original fixture scope. */

import {
  createAgentEditCodecFactory,
  getBlockItemId,
  toDocHandle,
  unwrapBlock,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { blockItemKey, type ReviewHunk } from "@meridian/contracts/drafts";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe as __mergedSuite, expect, it } from "vitest";
import * as Y from "yjs";
/** Writer evidence protects physical per-change independence through the real write harness. */
// Real write-tool journal deltas and selective-review replay contracts.
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import evidence from "./granularity-evidence.json";
import { createSemanticProvenanceWriter } from "./provenance.js";

__mergedSuite("draft-structural-order.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/draft-structural-order.test.ts.
  const schema = buildDocumentSchema();

  const model = yProsemirrorModel(schema);

  const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);

  function expectDisplayHonesty(live: Y.Doc, peer: Y.Doc, hunks: ReviewHunk[]) {
    const baseRefs = model.getBlocks(toDocHandle(live));
    const base = baseRefs.map((block) => model.getText(block));
    const baseIds = new Set(baseRefs.map((block) => model.getBlockId(block)));
    const liveKeys = new Set(baseRefs.map((block) => blockItemKey(getBlockItemId(block))));
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
        // A block taken out whole names the live block it was, which a re-forked draft still has.
        if (hunk.kind === "block" && hunk.deletedBlock)
          expect(liveKeys).toContain(hunk.deletedBlock.blockId);
        if (hunk.kind === "block")
          return {
            kind: "block" as const,
            block: from.index,
            order,
            inserted: hunk.insertedBlock?.display,
            deleted: hunk.deletedBlock?.display,
          };
        if (from.type instanceof Y.XmlFragment && !(from.type instanceof Y.XmlText)) {
          expect(liveKeys).toContain(hunk.deletedBlockId);
          return {
            kind: "block" as const,
            block: from.index,
            order,
            inserted: undefined,
            deleted: hunk.deletedText,
          };
        }
        expect(hunk.deletedBlockId).toBeUndefined();
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

  async function revision(before: string, after: string) {
    const h = createWriteToolHarness(
      { "chapter.md": before },
      { semanticProvenance: createSemanticProvenanceWriter() },
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
    const rows = (await h.journal.read("chapter.md")).updates.map((row) => ({
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
    const classes = new Map(
      review.operations.map((op) => [op.closureClassId, op.closureUpdateIds]),
    );
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

  it("preserves split and new-paragraph order on both sides", async () => {
    const before = "Alpha road. Beta valley.";
    for (const after of [
      "Alpha road.\n\nBeta dark valley.\n\nEntirely new story.\n\nAnother new story.",
      "Entirely new story.\n\nAlpha road.\n\nBeta dark valley.\n\nAnother new story.",
      "Alpha road.\n\nEntirely new story.\n\nBeta dark valley.\n\nAnother new story.",
    ])
      await revision(before, after);
  });

  it("unions overlapping split/merge boundaries and replays the connected change alone", async () => {
    const result = await revision(
      "Alpha road. Beta valley.\n\nGamma sea. Delta hill.",
      "Alpha road.\n\nBeta valley. Gamma sea.\n\nDelta hill.",
    );
    expect(result.classes.size).toBe(1);
    expect(result.isolated).toHaveLength(1);
    expect(result.isolated[0].map((node) => node.toJSON())).toEqual(
      result.expected.map((node) => node.toJSON()),
    );
  });

  it("preserves randomized split/merge/insertion order and each isolated class", async () => {
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
      await revision(before, blocks.join("\n\n"));
    }
  });

  it("keeps independent split components separate across adjacent or kept blocks", async () => {
    for (const sentinel of ["", "\n\nUntouched mountain."]) {
      const before = `Alpha road. Beta valley.${sentinel}\n\nGamma sea. Delta hill.`;
      const after = `Alpha road.\n\nBeta dark valley.${sentinel}\n\nGamma sea.\n\nDelta green hill.`;
      const result = await revision(before, after);
      expect(result.classes.size).toBe(2);
    }
  });

  it("keeps generated cross-paragraph common-word substitutions independently replayable", async () => {
    for (let sample = 0; sample < 12; sample++) {
      const before = [`Alpha${sample} takes the sword.`, `Beta${sample} drops a shield.`];
      const after = [`Alpha${sample} takes a sword.`, `Beta${sample} drops the shield.`];
      const result = await revision(before.join("\n\n"), after.join("\n\n"));
      expect(result.classes.size, `sample ${sample}`).toBe(2);
      expect(
        result.isolated.map((nodes) => nodes.map((node) => node.textContent).join("\n\n")).sort(),
      ).toEqual([[after[0], before[1]].join("\n\n"), [before[0], after[1]].join("\n\n")].sort());
    }
  });

  it("retains count-changing sentence splits as one exact change", async () => {
    for (const [oldCount, newCount] of [
      [1, 2],
      [1, 3],
      [2, 1],
      [3, 2],
    ]) {
      const result = await revision(
        `Alpha road. ${Array(oldCount).fill("Beta valley.").join(" ")}`,
        `Alpha road.\n\n${Array(newCount).fill("Beta valley.").join(" ")}`,
      );
      expect(result.classes.size).toBe(1);
      expect(result.isolated[0].map((node) => node.toJSON())).toEqual(
        result.expected.map((node) => node.toJSON()),
      );
    }
  });

  it("retains no-space word and single-token grapheme splits", async () => {
    for (const [before, after] of [
      ["青山绿水", "青山\n\n绿水"],
      ["abcdef", "abc\n\ndef"],
    ]) {
      const result = await revision(before, after);
      expect(result.classes.size).toBe(1);
      expect(result.isolated[0].map((node) => node.toJSON())).toEqual(
        result.expected.map((node) => node.toJSON()),
      );
    }
  });

  it("recognizes compatible word, punctuation and emoji boundary tokenization", async () => {
    for (const [before, after] of [
      ["Alpha Beta", "Alpha\n\nBeta"],
      ["Alpha Beta.", "Alpha\n\nBeta."],
      ["👩‍🚀 Hello", "👩‍🚀\n\nHello"],
    ]) {
      const result = await revision(before, after);
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
        const result = await revision(before, after);
        expect(result.classes.size).toBe(1);
      }
    }
  });

  it("conservatively joins structural windows beyond the character budget", async () => {
    for (const text of ["long ".repeat(850)]) {
      const result = await revision(
        `${text}ending.`,
        `${text}changed.\n\nEntirely unrelated addition.`,
      );
      expect(result.classes.size).toBe(1);
    }
  });

  it("joins three-way subword and repeated-word splits and reverse merges", async () => {
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
        const result = await revision(before, after);
        expect(result.classes.size).toBe(1);
      }
    }
  });
});

__mergedSuite("draft-write-granularity.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/draft-write-granularity.test.ts.
  it("replays each of the 4 paragraph evidence classes alone, with 21 whole-word hunks", async () => {
    const model = yProsemirrorModel(buildDocumentSchema());
    const h = createWriteToolHarness(
      { "chapter.md": evidence.before.join("\n\n") },
      {
        semanticProvenance: createSemanticProvenanceWriter(),
      },
    );
    const live = new Y.Doc({ gc: false });
    Y.applyUpdate(live, Y.encodeStateAsUpdate(h.liveDoc("chapter.md")));
    const context = { sessionId: "chat", threadId: "chat", turnId: "insert" };
    const blocks = model.getBlocks(toDocHandle(h.liveDoc("chapter.md")));
    const inserted = await h.core.write(
      {
        command: "insert",
        file: "chapter.md",
        after: model.getBlockId(blocks[blocks.length - 1]),
        content: evidence.inserted.slice(evidence.before.length).join("\n\n"),
      },
      context,
    );
    expect(inserted.result.status).toBe("success");
    const replaced = await h.core.write(
      {
        command: "replace",
        file: "chapter.md",
        in: [1, evidence.target.length],
        content: evidence.target.join("\n\n"),
      },
      { ...context, turnId: "pov" },
    );
    expect(replaced.result.status).toBe("success");
    const draft = h.liveDoc("chapter.md");
    expect(model.getBlocks(toDocHandle(draft)).map((b) => model.getText(b))).toEqual(
      evidence.target,
    );
    const journal = await h.journal.read("chapter.md");
    const rows = journal.updates.map((row) => ({
      id: row.seq,
      actorTurnId: row.meta.actorTurnId ?? null,
      updateData: row.update,
    }));
    const review = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: rows,
    });
    expect(review.hunks).toHaveLength(21);
    const classes = new Map(
      review.operations.map((op) => [op.closureClassId, op.closureUpdateIds]),
    );
    expect(classes.size).toBe(4);
    expect(review.hunks.filter((h) => h.kind === "text").map((h) => h.deletedText)).toContain(
      "did",
    );
    expect(review.hunks.filter((h) => h.kind === "text").map((h) => h.deletedText)).toContain(
      "bothered",
    );
    for (const ids of classes.values()) {
      const peer = new Y.Doc({ gc: false });
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(live));
      for (const row of rows.filter((row) => ids.some((id) => id === row.id)))
        Y.applyUpdate(peer, row.updateData);
      expect(peer.store.pendingStructs).toBeNull();
      expect(peer.store.pendingDs).toBeNull();
      peer.destroy();
    }
    const clients = new Set(Y.decodeStateVector(Y.encodeStateVector(live)).keys());
    for (const row of rows) {
      const fresh = new Set(Y.decodeUpdate(row.updateData).structs.map((s) => s.id.client));
      expect(fresh.size).toBe(1);
      for (const client of fresh) {
        expect(clients.has(client)).toBe(false);
        clients.add(client);
      }
    }
    live.destroy();
  });

  it("keeps paragraph splits, merges and contiguous insertions as one change", async () => {
    const model = yProsemirrorModel(buildDocumentSchema());
    for (const [before, after] of [
      ["Alpha road. Beta valley.", "Alpha road.\n\nBeta valley."],
      ["Alpha road.\n\nBeta valley.", "Alpha road. Beta valley."],
      ["Anchor.", "Anchor.\n\nOne.\n\nTwo.\n\nThree."],
    ]) {
      const h = createWriteToolHarness({ "chapter.md": before }, {});
      const live = new Y.Doc({ gc: false });
      Y.applyUpdate(live, Y.encodeStateAsUpdate(h.liveDoc("chapter.md")));
      const result = await h.core.write(
        {
          command: "replace",
          file: "chapter.md",
          in: [1, before.split("\n\n").length],
          content: after,
        },
        { sessionId: "chat", threadId: "chat", turnId: "structural" },
      );
      expect(result.isError).toBe(false);
      const journal = await h.journal.read("chapter.md");
      const review = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: h.liveDoc("chapter.md"),
        model,
        draftUpdates: journal.updates.map((row) => ({
          id: row.seq,
          actorTurnId: row.meta.actorTurnId ?? null,
          updateData: row.update,
        })),
      });
      expect(new Set(review.operations.map((op) => op.closureClassId)).size).toBe(1);
      live.destroy();
    }
  });

  it("keeps a six-paragraph new run independent of adjacent paragraph swaps, in the middle or at the end", async () => {
    const model = yProsemirrorModel(buildDocumentSchema());
    const before = [
      "Mara walks along the valley road.",
      "She watches the mountain pass.",
      "The priest follows her slowly.",
    ];
    const rewritten = [
      "I walk along the valley road.",
      "I watch the mountain pass.",
      "The priest follows me slowly.",
    ];
    const inserted = Array.from(
      { length: 6 },
      (_, i) => `New scene ${i + 1} opens beyond the village walls.`,
    );
    for (const position of [1, 3]) {
      const h = createWriteToolHarness({ "chapter.md": before.join("\n\n") }, {});
      const live = new Y.Doc({ gc: false });
      Y.applyUpdate(live, Y.encodeStateAsUpdate(h.liveDoc("chapter.md")));
      const after = [...rewritten.slice(0, position), ...inserted, ...rewritten.slice(position)];
      expect(
        (
          await h.core.write(
            { command: "replace", file: "chapter.md", in: [1, 3], content: after.join("\n\n") },
            { sessionId: "chat", threadId: "chat", turnId: "mixed" },
          )
        ).isError,
      ).toBe(false);
      const journal = await h.journal.read("chapter.md");
      const rows = journal.updates.map((row) => ({
        id: row.seq,
        actorTurnId: row.meta.actorTurnId ?? null,
        updateData: row.update,
      }));
      expect(rows).toHaveLength(4);
      const review = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: h.liveDoc("chapter.md"),
        model,
        draftUpdates: rows,
      });
      expect(new Set(review.operations.map((op) => op.closureClassId)).size).toBe(4);
      const newHunks = review.hunks.filter((hunk) => hunk.kind === "text" && !hunk.deletedText);
      expect(newHunks).toHaveLength(6);
      expect(new Set(newHunks.flatMap((hunk) => hunk.operationIds)).size).toBe(1);
      live.destroy();
    }
  });

  it("groups repeated matches by paragraph, but independent writes never group just for sharing one", async () => {
    const model = yProsemirrorModel(buildDocumentSchema());
    const h = createWriteToolHarness(
      { "chapter.md": "She climbs. She watches the stars.\n\nShe waits by the river." },
      {},
    );
    const live = new Y.Doc({ gc: false });
    Y.applyUpdate(live, Y.encodeStateAsUpdate(h.liveDoc("chapter.md")));
    const review = async () => {
      const journal = await h.journal.read("chapter.md");
      return computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: h.liveDoc("chapter.md"),
        model,
        draftUpdates: journal.updates.map((row) => ({
          id: row.seq,
          actorTurnId: row.meta.actorTurnId ?? null,
          updateData: row.update,
        })),
      });
    };
    expect(
      (
        await h.core.write(
          { command: "replace", file: "chapter.md", find: "She", all: true, content: "I" },
          { sessionId: "a", threadId: "a", turnId: "pronouns" },
        )
      ).isError,
    ).toBe(false);
    expect(new Set((await review()).operations.map((op) => op.closureClassId)).size).toBe(2);
    expect(
      (
        await h.core.write(
          { command: "replace", file: "chapter.md", find: "stars", content: "clouds" },
          { sessionId: "b", threadId: "b", turnId: "independent" },
        )
      ).isError,
    ).toBe(false);
    expect(new Set((await review()).operations.map((op) => op.closureClassId)).size).toBe(3);
    // Editing newly supplied text really depends on that write, even from another chat.
    expect(
      (
        await h.core.write(
          { command: "replace", file: "chapter.md", find: "clouds", content: "moon" },
          { sessionId: "c", threadId: "c", turnId: "dependent" },
        )
      ).isError,
    ).toBe(false);
    expect(new Set((await review()).operations.map((op) => op.closureClassId)).size).toBe(3);
    live.destroy();
  });

  it("absorbs overlapping edits before and after a large rewrite, transitively, while keeping untouched words separate", async () => {
    const model = yProsemirrorModel(buildDocumentSchema());
    const before = [
      "Mara raises the jade sword and waits beside the old gate.",
      "The priest walks down the quiet road.",
      "Snow falls over the distant mountain.",
    ];
    const h = createWriteToolHarness({ "chapter.md": before.join("\n\n") }, {});
    const live = new Y.Doc({ gc: false });
    Y.applyUpdate(live, Y.encodeStateAsUpdate(h.liveDoc("chapter.md")));
    const write = async (find: string, content: string, threadId: string) => {
      expect(
        (
          await h.core.write(
            { command: "replace", file: "chapter.md", find, content },
            { sessionId: threadId, threadId, turnId: threadId },
          )
        ).isError,
      ).toBe(false);
    };
    const count = async () => {
      const journal = await h.journal.read("chapter.md");
      const review = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: h.liveDoc("chapter.md"),
        model,
        draftUpdates: journal.updates.map((row) => ({
          id: row.seq,
          actorTurnId: row.meta.actorTurnId ?? null,
          updateData: row.update,
        })),
      });
      return new Set(review.operations.map((op) => op.closureClassId)).size;
    };
    await write("jade", "silver", "before-overlap");
    await write("old", "ancient", "before-independent");
    const target = [
      "I raise the iron blade and wait beside the ancient gate.",
      "The priest runs down the silent road.",
      "Rain falls over the nearby mountain.",
    ];
    expect(
      (
        await h.core.write(
          { command: "replace", file: "chapter.md", in: [1, 3], content: target.join("\n\n") },
          { sessionId: "big", threadId: "big", turnId: "big" },
        )
      ).isError,
    ).toBe(false);
    expect(await count()).toBe(4);
    await write("iron", "steel", "after-overlap");
    expect(await count()).toBe(4);
    await write("steel", "bronze", "transitive");
    expect(await count()).toBe(4);
    await write("gate", "arch", "after-independent");
    expect(await count()).toBe(5);
    live.destroy();
  });

  it("retains unchanged word identities, replaces whole words, and joins writer typing inside a pending segment", async () => {
    const model = yProsemirrorModel(buildDocumentSchema());
    const h = createWriteToolHarness({ "chapter.md": "She had been told the pass did close." }, {});
    const draft = h.liveDoc("chapter.md");
    const live = new Y.Doc({ gc: false });
    Y.applyUpdate(live, Y.encodeStateAsUpdate(draft));
    const text = draft.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
    const prose = text.get(0) as Y.XmlText;
    const unchanged = Y.createRelativePositionFromTypeIndex(prose, prose.toString().indexOf("had"));
    const oldDid = Y.createRelativePositionFromTypeIndex(prose, prose.toString().indexOf("did"));
    const baselineClients = new Set(Y.decodeStateVector(Y.encodeStateVector(draft)).keys());
    expect(
      (
        await h.core.write(
          {
            command: "replace",
            file: "chapter.md",
            in: 1,
            content: "I had been told the pass does close.",
          },
          { sessionId: "chat", threadId: "chat", turnId: "pov" },
        )
      ).isError,
    ).toBe(false);
    expect(Y.createRelativePositionFromTypeIndex(prose, prose.toString().indexOf("had"))).toEqual(
      unchanged,
    );
    const newDoes = Y.createRelativePositionFromTypeIndex(prose, prose.toString().indexOf("does"));
    expect(newDoes.item).not.toEqual(oldDid.item);
    if (!newDoes.item) throw new Error("Replacement must have a fresh item identity");
    expect(baselineClients.has(newDoes.item.client)).toBe(false);
    const rows = (await h.journal.read("chapter.md")).updates.map((row) => ({
      id: row.seq,
      actorTurnId: row.meta.actorTurnId ?? null,
      updateData: row.update,
    }));
    draft.clientID = 12345678;
    let typing: Uint8Array | undefined;
    draft.once("update", (update: Uint8Array) => {
      typing = update;
    });
    prose.insert(prose.toString().indexOf("does") + 2, "really");
    if (!typing) throw new Error("Writer typing must emit an update");
    const review = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: [...rows, { id: 100, actorTurnId: null, updateData: typing }],
    });
    expect(new Set(review.operations.map((op) => op.closureClassId)).size).toBe(1);
    expect(review.operations.every((op) => op.closureUpdateIds.some((id) => id === 100))).toBe(
      true,
    );
    live.destroy();
  });

  it("certifies replacement of a canonical empty paragraph", async () => {
    const model = yProsemirrorModel(buildDocumentSchema());
    const h = createWriteToolHarness(
      { "chapter.md": "" },
      { semanticProvenance: createSemanticProvenanceWriter() },
    );
    expect(
      (
        await h.core.write(
          { command: "replace", file: "chapter.md", in: 1, content: "Hello world." },
          { sessionId: "chat", threadId: "chat", turnId: "empty" },
        )
      ).result.status,
    ).toBe("success");
    expect(
      model.getBlocks(toDocHandle(h.liveDoc("chapter.md"))).map((block) => model.getText(block)),
    ).toEqual(["Hello world."]);
    expect((await h.journal.read("chapter.md")).updates).toHaveLength(1);
  });

  it.each([
    [
      "Alpha road. Beta valley.\n\nUntouched mountain.",
      "Alpha road.\n\nUntouched mountain.\n\nBeta valley.",
      2,
    ],
    [
      "He carries his sword.\n\nUnchanged sentinel.",
      "He carries his axe.\n\nUnchanged sentinel.\n\ns",
      2,
    ],
    ["He carries his sword.", "He carries his axe.\n\ns", 2],
    ["Alpha road. Beta valley.", "Alpha road.\n\nBeta dark valley.", 1],
  ] as const)("recognizes document boundaries, not substring coincidence: %s", async (before, after, count) => {
    const model = yProsemirrorModel(buildDocumentSchema());
    const h = createWriteToolHarness(
      { "chapter.md": before },
      { semanticProvenance: createSemanticProvenanceWriter() },
    );
    const live = new Y.Doc({ gc: false });
    Y.applyUpdate(live, Y.encodeStateAsUpdate(h.liveDoc("chapter.md")));
    expect(
      (
        await h.core.write(
          {
            command: "replace",
            file: "chapter.md",
            in: [1, before.split("\n\n").length],
            content: after,
          },
          { sessionId: "chat", threadId: "chat", turnId: "boundaries" },
        )
      ).result.status,
    ).toBe("success");
    const rows = (await h.journal.read("chapter.md")).updates.map((row) => ({
      id: row.seq,
      actorTurnId: row.meta.actorTurnId ?? null,
      updateData: row.update,
    }));
    const review = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: h.liveDoc("chapter.md"),
      model,
      draftUpdates: rows,
    });
    expect(rows).toHaveLength(count);
    expect(new Set(review.operations.map((op) => op.closureClassId)).size).toBe(count);
    live.destroy();
  });
});

__mergedSuite("write-update-granularity.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/write-update-granularity.test.ts.
  const model = yProsemirrorModel(buildDocumentSchema());

  const original =
    "Alpha sword gleamed. The elder waited beside the gate, studying the long road in silence.\n\n" +
    "Beta shield shone. The disciple waited beside the river, studying the distant mountain in silence.";

  const text = (doc: Y.Doc) =>
    model
      .getBlocks(toDocHandle(doc))
      .map((block) => model.getText(block))
      .join("\n\n");

  function clone(doc: Y.Doc) {
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    return copy;
  }

  __mergedSuite("per-write journal encoding", () => {
    it.each([
      {
        name: "two overwrite chats, aligned different paragraphs",
        sameChat: false,
        reread: true,
        sentence: false,
        dependent: false,
        classes: 2,
        overwrite: true,
      },
      {
        name: "two chats, different paragraphs",
        sameChat: false,
        reread: true,
        sentence: false,
        dependent: false,
        classes: 2,
      },
      {
        name: "two chats, different sentences",
        sameChat: false,
        reread: true,
        sentence: true,
        dependent: false,
        classes: 2,
      },
      {
        name: "one chat, two turns with a read between",
        sameChat: true,
        reread: true,
        sentence: false,
        dependent: false,
        classes: 2,
      },
      {
        name: "one chat keeps independent fresh-client writes without a read",
        sameChat: true,
        reread: false,
        sentence: false,
        dependent: false,
        classes: 2,
      },
      {
        name: "B edits text supplied by A",
        sameChat: false,
        reread: true,
        sentence: false,
        dependent: true,
        classes: 1,
      },
    ])("$name", async ({ sameChat, reread, sentence, dependent, classes, overwrite }) => {
      let client = 50000;
      const docs: Y.Doc[] = [];
      const h = createWriteToolHarness(
        { "chapter.md": original },
        {
          semanticProvenance: createSemanticProvenanceWriter(),
          createRuntimeDoc: () => {
            const doc = new Y.Doc({ gc: false });
            doc.clientID = client++;
            docs.push(doc);
            return doc;
          },
        },
      );
      const draft = h.liveDoc("chapter.md");
      const live = clone(draft);
      const edits = [
        { find: "sword", content: "blade" },
        dependent
          ? { find: "blade", content: "bright blade" }
          : sentence
            ? { find: "The elder waited", content: "The master watched" }
            : { find: "shield", content: "buckler" },
      ];
      try {
        for (const [i, edit] of edits.entries()) {
          const threadId = i === 0 || sameChat ? "chat-a" : "chat-b";
          const context = {
            sessionId: threadId,
            threadId,
            turnId: `turn-${i + 1}`,
            responseIdentity: {
              providerResponseId: `reply-${i + 1}`,
              editScopeId: `reply-${i + 1}`,
            },
            ...(overwrite ? { createdDocument: false } : {}),
            interactionContext: {
              mode: "threadPeer" as const,
              afterJournalId: i,
              branchGeneration: 1,
            },
          };
          if (i === 0 || !sameChat || reread)
            expect((await h.core.read({ file: "chapter.md" }, context)).result.status).toBe(
              "success",
            );
          expect(
            (
              await h.core.write(
                overwrite
                  ? {
                      command: "create",
                      file: "chapter.md",
                      overwrite: true,
                      content: text(draft).replace(edit.find, edit.content),
                    }
                  : { command: "replace", file: "chapter.md", ...edit },
                context,
              )
            ).result.status,
          ).toBe("success");
          expect((await h.core.commitResponse(context.responseIdentity?.editScopeId)).status).toBe(
            "committed",
          );
        }
        const journal = await h.journal.read("chapter.md");
        expect(journal.updates).toHaveLength(2);
        const rows = journal.updates.map((row, i) => ({
          id: i + 1,
          actorTurnId: `turn-${i + 1}`,
          updateData: row.update,
        }));
        const preview = computeDraftReviewHunks({
          liveDoc: live,
          draftDoc: draft,
          model,
          draftUpdates: rows,
        });
        if (!dependent) expect(preview.operations).toHaveLength(2);
        const classIds = new Set(preview.operations.map((op) => op.closureClassId));
        expect(classIds.size).toBe(classes);
        // Every server-vended class replays alone with exactly its claimed effects.
        for (const classId of classIds) {
          const selected = preview.operations.filter((op) => op.closureClassId === classId);
          const ids = new Set<number>(selected.flatMap((op) => op.closureUpdateIds));
          if (classes === 2) expect([...ids]).toEqual(selected.map((op) => Number(op.operationId)));
          const applied = clone(live);
          try {
            for (const row of rows.filter((row) => ids.has(row.id)))
              Y.applyUpdate(applied, row.updateData);
            let expected = original;
            for (const [i, edit] of edits.entries())
              if (ids.has(i + 1)) expected = expected.replace(edit.find, edit.content);
            expect(text(applied)).toBe(expected);
            expect(applied.store.pendingStructs).toBeNull();
            expect(applied.store.pendingDs).toBeNull();
          } finally {
            applied.destroy();
          }
        }
        expect(text(draft)).toBe(
          original
            .replace(edits[0].find, edits[0].content)
            .replace(edits[1].find, edits[1].content),
        );
      } finally {
        live.destroy();
        draft.destroy();
        for (const doc of docs) doc.destroy();
      }
    });
  });
});
