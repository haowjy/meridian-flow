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
      onUnexpectedWriteError: (e) => console.error(e),
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
      after: model.getBlockId(blocks.at(-1)!),
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
