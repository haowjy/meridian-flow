/** Rich review classes publish and discard exact trees without inventing text effects. */
import { toDocHandle, unwrapBlock } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { publicationBlockChanges } from "./branch-push-plan.js";
import { journalAttributionByChangedBlock } from "./branch-trail-projection.js";
import { documentEffectsEqual } from "./document-content.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { cloneDoc, codec, createDoc, model } from "./draft-review-test-fixture.js";

it.each([
  { kind: "bold", before: "Alpha", after: "**Alpha**" },
  { kind: "italic", before: "Alpha", after: "*Alpha*" },
  {
    kind: "link",
    before: "[Alpha](https://old.example.com)",
    after: "[Alpha](https://example.com)",
  },
  { kind: "heading level", before: "## Alpha", after: "### Alpha" },
  { kind: "list type", before: "- Alpha", after: "1. Alpha" },
  { kind: "split", before: "> AlphaBeta", after: "> Alpha\n>\n> Beta" },
  { kind: "restore then retype", before: "**Alpha** and **Beta**", after: "Alpha and **Beta**" },
])("reviews, Applies and Discards $kind with exact content and attribution", ({
  kind,
  before,
  after,
}) => {
  const live = createDoc(`${before}\n\nControl`);
  const draft = cloneDoc(live);
  const rows: {
    id: number;
    actorTurnId: string | null;
    actorUserId?: string;
    updateData: Uint8Array;
  }[] = [];
  const write = (id: number, edit: () => void, writer = false) => {
    draft.clientID = id + 100;
    rows.push({
      id,
      actorTurnId: writer ? null : `turn-${id}`,
      ...(writer ? { actorUserId: "writer" } : {}),
      updateData: (() => {
        const deltas: Uint8Array[] = [];
        const capture = (delta: Uint8Array) => deltas.push(delta);
        draft.on("update", capture);
        try {
          draft.transact(edit);
        } finally {
          draft.off("update", capture);
        }
        return Y.mergeUpdates(deltas);
      })(),
    });
  };
  try {
    const first = model.getBlocks(toDocHandle(draft))[0];
    if (kind === "restore then retype") {
      write(9, () => {
        const text = unwrapBlock(first).get(0) as Y.XmlText;
        text.delete(0, text.length);
        text.insert(0, "Alpha and Beta");
        text.format(0, 5, { strong: {} });
        text.format(10, 4, { strong: {} });
      });
    }
    if (kind === "heading level")
      write(9, () => {
        const heading = unwrapBlock(first);
        const level = heading.getAttribute("level");
        if (level === undefined) throw new Error("Missing heading level");
        heading.setAttribute("level", level);
      });
    if (rows.length > 0) {
      // History alone is not a content change; stable block identity survives retyping.
      expect(documentEffectsEqual(live, draft)).toBe(true);
      expect(
        computeDraftReviewHunks({ liveDoc: live, draftDoc: draft, model, draftUpdates: rows })
          .hunks,
      ).toEqual([]);
      expect(publicationBlockChanges({ model, beforeDoc: live, afterDoc: draft })).toEqual([]);
    }
    write(10, () => {
      if (kind === "list type") {
        model.insertBlocks(toDocHandle(draft), first, codec.parse(after));
        model.deleteBlock(toDocHandle(draft), first);
      } else model.applyBlockReplacement(toDocHandle(draft), first, codec.parse(after).blocks[0]);
    });
    write(
      11,
      () => {
        const control = model.getBlocks(toDocHandle(draft)).at(-1);
        if (!control) throw new Error("Missing control");
        model.applyTextEdit(toDocHandle(draft), control, { from: 0, to: 7 }, "Writer control");
      },
      true,
    );
    const preview = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: rows,
    });
    expect(preview.diagnostics).toEqual([]);
    if (kind === "split")
      expect(preview.hunks[0]).toMatchObject({
        kind: "block",
        formatting: [{ kind: "structure" }],
      });
    expect(new Set(preview.operations.map((op) => op.closureClassId)).size).toBe(2);
    const selected = preview.operations.find((op) => op.sourceUpdateIds.includes(10 as never));
    if (!selected) throw new Error("Missing rich change");
    expect(selected.canApplyOrDiscard).not.toBe(false);
    expect(selected.sourceUpdateIds).toEqual([10]);
    const ids = new Set(selected.closureUpdateIds);
    expect(ids.has(11 as never)).toBe(false);
    const applied = cloneDoc(live);
    const discarded = cloneDoc(live);
    try {
      for (const row of rows)
        Y.applyUpdate(ids.has(row.id as never) ? applied : discarded, row.updateData);
      const trees = (doc: Y.Doc) =>
        model.projectBlocks(toDocHandle(doc)).map((node) => node.toJSON());
      const expected = (markdown: string) =>
        codec.parse(markdown).blocks.map((node) => node.toJSON());
      expect(trees(applied)).toEqual(expected(`${after}\n\nControl`));
      expect(trees(discarded)).toEqual(expected(`${before}\n\nWriter control`));
      expect(documentEffectsEqual(live, applied)).toBe(false);
      const published = publicationBlockChanges({ model, beforeDoc: live, afterDoc: applied });
      expect(published.length).toBeGreaterThan(0);
      const attribution = journalAttributionByChangedBlock({
        liveDoc: live,
        model,
        rows: rows
          .filter((row) => ids.has(row.id as never))
          .map((row) => ({
            id: row.id,
            branchId: "draft",
            generation: 1,
            wId: row.id,
            source: "agent" as const,
            threadId: "chat" as ThreadId,
            turnId: row.actorTurnId as TurnId | null,
            actorUserId: null,
            updateData: row.updateData,
            draftBaseUpdateSeq: 1,
            status: "active" as const,
          })),
      });
      for (const change of published)
        expect(attribution.ownersByBlock.get(change.blockId)).toEqual([
          { threadId: "chat", turnId: "turn-10" },
        ]);
      const remainder = computeDraftReviewHunks({
        liveDoc: applied,
        draftDoc: draft,
        model,
        draftUpdates: rows.filter((row) => !ids.has(row.id as never)),
      });
      expect(remainder.operations.map((op) => op.sourceUpdateIds)).toEqual([[11]]);
      const rejected = computeDraftReviewHunks({
        liveDoc: live,
        draftDoc: discarded,
        model,
        draftUpdates: rows.filter((row) => !ids.has(row.id as never)),
      });
      expect(rejected.operations.map((op) => op.sourceUpdateIds)).toEqual([[11]]);
    } finally {
      applied.destroy();
      discarded.destroy();
    }
  } finally {
    live.destroy();
    draft.destroy();
  }
});
