/** Real-Yjs draft review behavioral coverage. */
import { type SemanticEditIRV1, toDocHandle } from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import {
  captureUpdate,
  cloneDoc,
  codec,
  createDoc,
  model,
  spanTextRange,
} from "./draft-review-test-fixture.js";
import { createSemanticProvenanceWriter, PROVENANCE_TARGETS_TYPE } from "./provenance.js";

describe("draft review class-replay", () => {
  it("fact-carrying structural writes in separate paragraphs replay independently", () => {
    const live = createDoc("Alpha Beta.\n\nDivider.\n\nBlue Silver."),
      draft = cloneDoc(live);
    try {
      const updates = [
        { id: 1, prefix: 6, output: "Gamma Beta." },
        { id: 2, prefix: 5, output: "Gold Silver." },
      ].map(({ id, prefix, output }, index) => {
        const paragraph = index * 2;
        draft.clientID = 900 + id;
        const block = model.getBlocks(toDocHandle(draft))[paragraph];
        const source = model.getVisibleContentLineage(block)[0];
        const replacement = codec.parse(output).blocks[0];
        const before = Y.encodeStateVector(draft);
        const ir: SemanticEditIRV1 = {
          version: 1,
          documentId: "doc",
          inputRevision: "revision" as never,
          scope: [source],
          deleted: [source],
          intent: {
            kind: "mappedEdits",
            edits: [
              {
                edit: { kind: "block", documentId: "doc", file: "doc.md", block, replacement },
                outputRuns: [
                  {
                    kind: "fresh",
                    payload: output.slice(0, prefix),
                    output: { from: 0, to: prefix },
                  },
                  {
                    kind: "preserved",
                    source: {
                      ...source,
                      clock: source.clock + prefix,
                      length: output.length - prefix,
                    },
                    output: { from: prefix, to: output.length },
                  },
                ],
              },
            ],
          },
        };
        const updateData = Y.mergeUpdates(
          captureMutationUpdates(draft, () =>
            draft.transact(() => {
              const previous =
                paragraph === 0 ? null : model.getBlocks(toDocHandle(draft))[paragraph - 1];
              model.deleteBlock(toDocHandle(draft), block);
              model.insertBlocks(toDocHandle(draft), previous, codec.parse(output));
              createSemanticProvenanceWriter().writeCertifiedFacts(toDocHandle(draft), ir, before);
            }),
          ),
        );
        const structs = Y.decodeUpdate(updateData).structs;
        expect(new Set(structs.map((item) => item.id.client))).toEqual(new Set([900 + id]));
        const facts = structs.filter(
          (item) => item instanceof Y.Item && (item.parent as unknown) === PROVENANCE_TARGETS_TYPE,
        ) as Y.Item[];
        expect(facts.length).toBeGreaterThan(0);
        for (const fact of facts) {
          expect(fact.origin).toBeNull();
          expect(fact.rightOrigin).toBeNull();
        }
        return { id, actorTurnId: `turn-${id}`, updateData };
      });
      const preview = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: draft,
        model,
        draftUpdates: updates,
      });
      expect(preview.operations).toHaveLength(2);
      expect(new Set(preview.operations.map((op) => op.closureClassId)).size).toBe(2);
      for (const [index, row] of updates.entries()) {
        const replay = cloneDoc(live);
        try {
          Y.applyUpdate(replay, row.updateData);
          expect(model.getBlocks(toDocHandle(replay)).map((block) => model.getText(block))).toEqual(
            index === 0
              ? ["Gamma Beta.", "Divider.", "Blue Silver."]
              : ["Alpha Beta.", "Divider.", "Gold Silver."],
          );
          expect(replay.store.pendingStructs).toBeNull();
        } finally {
          replay.destroy();
        }
      }
    } finally {
      live.destroy();
      draft.destroy();
    }
  });

  it.each([
    { label: "shared client with adjacent rewrite", adjacentRewrite: true, freshPeers: false },
    { label: "fresh chat peers (reported operation 72)", adjacentRewrite: false, freshPeers: true },
  ])("applies every class and its preview complement ($label)", ({
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
      const reviewed = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: applied,
        model,
        draftUpdates: updates.filter((row) => rowIds.has(row.id)),
      });
      expect(signature(reviewed.hunks), classId).toEqual(
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
});
