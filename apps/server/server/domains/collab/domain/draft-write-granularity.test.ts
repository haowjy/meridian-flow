/** Writer evidence protects physical per-change independence through the real write harness. */
import { toDocHandle, yProsemirrorModel } from "@meridian/agent-edit/integration";
import { createWriteToolHarness } from "@meridian/agent-edit/test-support";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import evidence from "./granularity-evidence.json";
import { createSemanticProvenanceWriter } from "./provenance.js";

it("replays each of the 4 paragraph evidence classes alone, with 21 whole-word hunks", async () => {
  const model = yProsemirrorModel(buildDocumentSchema());
  const h = createWriteToolHarness(
    { "chapter.md": evidence.before.join("\n\n") },
    {
      segmentDraftWrites: true,
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
  expect(model.getBlocks(toDocHandle(draft)).map((b) => model.getText(b))).toEqual(evidence.target);
  const journal = await h.journal.readForReconstruction("chapter.md");
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
  const classes = new Map(review.operations.map((op) => [op.closureClassId, op.closureUpdateIds]));
  expect(classes.size).toBe(4);
  expect(review.hunks.filter((h) => h.kind === "text").map((h) => h.deletedText)).toContain("did");
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
    const h = createWriteToolHarness({ "chapter.md": before }, { segmentDraftWrites: true });
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
    const journal = await h.journal.readForReconstruction("chapter.md");
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
    const h = createWriteToolHarness(
      { "chapter.md": before.join("\n\n") },
      { segmentDraftWrites: true },
    );
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
    const journal = await h.journal.readForReconstruction("chapter.md");
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
    { segmentDraftWrites: true },
  );
  const live = new Y.Doc({ gc: false });
  Y.applyUpdate(live, Y.encodeStateAsUpdate(h.liveDoc("chapter.md")));
  const review = async () => {
    const journal = await h.journal.readForReconstruction("chapter.md");
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
  const h = createWriteToolHarness(
    { "chapter.md": before.join("\n\n") },
    { segmentDraftWrites: true },
  );
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
    const journal = await h.journal.readForReconstruction("chapter.md");
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
  const h = createWriteToolHarness(
    { "chapter.md": "She had been told the pass did close." },
    { segmentDraftWrites: true },
  );
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
  const rows = (await h.journal.readForReconstruction("chapter.md")).updates.map((row) => ({
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
  expect(review.operations.every((op) => op.closureUpdateIds.some((id) => id === 100))).toBe(true);
  live.destroy();
});

it.each([
  false,
  true,
])("certifies replacement of a canonical empty paragraph (draft=%s)", async (segmentDraftWrites) => {
  const model = yProsemirrorModel(buildDocumentSchema());
  const h = createWriteToolHarness(
    { "chapter.md": "" },
    { segmentDraftWrites, semanticProvenance: createSemanticProvenanceWriter() },
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
  expect((await h.journal.readForReconstruction("chapter.md")).updates).toHaveLength(1);
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
    { segmentDraftWrites: true, semanticProvenance: createSemanticProvenanceWriter() },
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
  const rows = (await h.journal.readForReconstruction("chapter.md")).updates.map((row) => ({
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
