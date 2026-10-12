/** Rich review classes publish and discard exact trees without inventing text effects. */
import {
  createAgentEditCodecFactory,
  snapshotBlocks,
  toDocHandle,
  unwrapBlock,
} from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { publicationBlockChanges } from "./branch-push-plan.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";
import { documentEffectsEqual } from "./document-content.js";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import { cloneDoc, codec, createDoc, model } from "./draft-review-test-fixture.js";

it.each([
  "marks",
  "heading level",
  "structural blocks",
  "text restoration with novel rich effects",
  "restore then retype and identical recreated run",
  "different-identity formatted replacement",
  "uncertified writer formatting copy",
])("reviews, Applies and Discards %s with exact content and attribution", (group) => {
  if (group === "text restoration with novel rich effects") {
    for (const variant of ["plain", "bold", "attribute", "node"] as const)
      verifyTextRestoration(variant);
  } else if (group === "structural blocks") {
    verifyRichChange("list type", "- Alpha", "1. Alpha");
    verifyRichChange("split", "> AlphaBeta", "> Alpha\n>\n> Beta");
  } else if (group === "different-identity formatted replacement") {
    for (const independent of [false, true]) verifyHistoryDifference("replacement", independent);
  } else if (group === "uncertified writer formatting copy") {
    for (const neighbor of [false, true]) verifyHistoryDifference("writer", neighbor);
  } else if (group === "restore then retype and identical recreated run") {
    verifyHistoryDifference("recreated run", false);
    verifyRichChange("restore then retype", "**Alpha** and **Beta**", "Alpha and **Beta**");
  } else if (group === "marks") {
    for (const [kind, before, after] of [
      ["bold", "Alpha", "**Alpha**"],
      ["italic", "Alpha", "*Alpha*"],
      ["link", "[Alpha](https://old.example.com)", "[Alpha](https://example.com)"],
    ])
      verifyRichChange(kind, before, after);
  } else {
    verifyRichChange(group, "## Alpha", "### Alpha");
  }
});

function verifyRichChange(kind: string, before: string, after: string) {
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
    if (kind === "bold") {
      draft.getMap("documents").set("managed-document", true);
      expect(documentEffectsEqual(live, draft)).toBe(false);
      expect(publicationBlockChanges({ model, beforeDoc: live, afterDoc: draft })).toEqual([]);
      draft.getMap("documents").delete("managed-document");
      expect(documentEffectsEqual(live, draft)).toBe(true);
    }
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
    const source = kind === "restore then retype" ? 9 : 10;
    const selected = preview.operations.find((op) => op.sourceUpdateIds.includes(source as never));
    if (!selected) throw new Error("Missing rich change");
    expect(selected.canApplyOrDiscard).not.toBe(false);
    expect(selected.sourceUpdateIds).toEqual([source]);
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
          { threadId: "chat", turnId: `turn-${source}` },
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
}

/** Semantic equality never certifies ownership; identity replacements retain both rows. */
function verifyHistoryDifference(
  kind: "replacement" | "writer" | "recreated run",
  variant: boolean,
) {
  const before = kind === "replacement" ? "red" : kind === "writer" ? "red blue" : "Alpha\n\nBeta";
  const after = kind === "replacement" ? "**red**" : kind === "writer" ? "**red** blue" : before;
  const live = createDoc(`${before}\n\nControl`);
  const draft = cloneDoc(live);
  const rows: {
    id: number;
    actorTurnId: string | null;
    actorUserId?: string;
    updateData: Uint8Array;
  }[] = [];
  const write = (edit: () => void, writer = false) => {
    const id = rows.length + 1;
    draft.clientID = 200 + id;
    const deltas: Uint8Array[] = [];
    const capture = (update: Uint8Array) => deltas.push(update);
    draft.on("update", capture);
    try {
      draft.transact(edit);
    } finally {
      draft.off("update", capture);
    }
    rows.push({
      id,
      actorTurnId: writer ? null : `turn-${id}`,
      ...(writer ? { actorUserId: "writer" } : {}),
      updateData: Y.mergeUpdates(deltas),
    });
  };
  const text = (index = 0) =>
    unwrapBlock(model.getBlocks(toDocHandle(draft))[index]).get(0) as Y.XmlText;
  const insert = () => model.insertBlocks(toDocHandle(draft), null, codec.parse(after));
  const remove = () =>
    model.deleteBlock(toDocHandle(draft), model.getBlocks(toDocHandle(draft))[0]);
  const trees = (doc: Y.Doc) => model.projectBlocks(toDocHandle(doc)).map((node) => node.toJSON());
  const expected = (markdown: string) => codec.parse(markdown).blocks.map((node) => node.toJSON());
  try {
    if (kind === "replacement") {
      if (variant) {
        write(remove);
        write(insert);
      } else
        write(() => {
          remove();
          insert();
        });
    } else if (kind === "writer") {
      write(() => text().format(0, 3, { strong: {} }));
      write(() => {
        const target = text();
        target.delete(0, target.length);
        target.insert(0, "red blue");
        target.format(0, 3, { strong: {} });
        if (variant) text(1).insert(7, "!");
      }, true);
    } else {
      write(() => {
        remove();
        remove();
        insert();
      });
      expect(documentEffectsEqual(live, draft)).toBe(true);
    }
    if (kind !== "writer")
      write(() => text(model.getBlocks(toDocHandle(draft)).length - 1).insert(7, "!"));
    const preview = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: rows,
    });
    expect(preview.diagnostics).toEqual([]);
    expect(preview.operations.every((op) => op.canApplyOrDiscard !== false)).toBe(true);
    const publication = publicationBlockChanges({ model, beforeDoc: live, afterDoc: draft });
    if (kind === "recreated run") {
      expect(preview.hunks).toHaveLength(1);
      expect(publication).toHaveLength(1);
      expect(preview.operations.map((op) => op.sourceUpdateIds)).toEqual([[2]]);
    } else if (kind === "writer") {
      expect(
        preview.operations.every((op) => op.kind === "writer" && op.actorUserId === "writer"),
      ).toBe(true);
      expect(preview.operations.map((op) => op.sourceUpdateIds)).toEqual([[2]]);
      expect(preview.operations[0].closureUpdateIds).toEqual([1, 2]);
    } else {
      expect(preview.hunks[0]).toMatchObject({
        kind: "block",
        formatting: [{ kind: "structure" }],
      });
      expect(publication).toHaveLength(2);
      const sources = preview.operations
        .filter((op) => op.closureClassId === preview.operations[0].closureClassId)
        .flatMap((op) => op.sourceUpdateIds);
      expect(sources).toEqual(variant ? [1, 2] : [1]);
    }
    for (const closureClassId of new Set(preview.operations.map((op) => op.closureClassId))) {
      const operations = preview.operations.filter((op) => op.closureClassId === closureClassId);
      const ids = new Set(operations.flatMap((op) => op.closureUpdateIds));
      const applied = cloneDoc(live),
        discarded = cloneDoc(live);
      try {
        for (const row of rows)
          Y.applyUpdate(ids.has(row.id as never) ? applied : discarded, row.updateData);
        const main = kind === "writer" || (kind === "replacement" && ids.has(1 as never));
        const neighbor = kind === "writer" ? variant : !main;
        expect(trees(applied)).toEqual(
          expected(`${main ? after : before}\n\nControl${neighbor ? "!" : ""}`),
        );
        expect(trees(discarded)).toEqual(
          expected(
            `${!main && kind === "replacement" ? after : before}\n\nControl${!neighbor && kind !== "writer" ? "!" : ""}`,
          ),
        );
        expect(documentEffectsEqual(live, applied)).toBe(false);
        if (kind === "replacement" && main)
          verifyReplacementTrail(
            live,
            applied,
            rows.filter((row) => ids.has(row.id as never)),
          );
      } finally {
        applied.destroy();
        discarded.destroy();
      }
    }
  } finally {
    live.destroy();
    draft.destroy();
  }
}

function verifyReplacementTrail(
  live: Y.Doc,
  draft: Y.Doc,
  rows: { id: number; actorTurnId: string | null; updateData: Uint8Array }[],
) {
  const scopedCodec = createAgentEditCodecFactory(codec).forScope(UNSCOPED_DOCUMENT_LINKS);
  const before = snapshotBlocks(toDocHandle(live), model, scopedCodec);
  const after = snapshotBlocks(toDocHandle(draft), model, scopedCodec);
  const bodies = (doc: Y.Doc) =>
    new Map(
      (doc === live ? before : after).map((block) => [
        `${block.clientID}:${block.clock}`,
        block.serialized,
      ]),
    );
  const changedBlocks = publicationBlockChanges({
    model,
    beforeDoc: live,
    afterDoc: draft,
    renderBlock(doc, block) {
      const identity = model.getCanonicalBlockIdentity(block);
      const body = bodies(doc).get(`${identity.clientID}:${identity.clock}`);
      if (body === undefined) throw new Error("Missing rich snapshot");
      return body;
    },
  });
  const attribution = journalAttributionByChangedBlock({
    liveDoc: live,
    model,
    rows: rows.map((row) => ({
      ...row,
      branchId: "draft",
      generation: 1,
      wId: row.id,
      source: "agent" as const,
      threadId: `thread-${row.id}` as ThreadId,
      turnId: row.actorTurnId as TurnId,
      actorUserId: null,
      draftBaseUpdateSeq: 1,
      status: "active" as const,
    })),
  });
  const afterById = new Map(
    model
      .getBlocks(toDocHandle(draft))
      .map((block) => [model.getBlockId(block), unwrapBlock(block)]),
  );
  const documentId = "document" as never;
  const trail = preparedTrailChanges({
    documentId,
    changedBlocks,
    receiptId: "receipt",
    ownersByBlock: attribution.ownersByBlock,
    operations: attribution.operations.map((operation) => ({
      ...operation,
      insertedBlocks: operation.insertedBlockIds.flatMap((blockId) => {
        const block = afterById.get(blockId);
        return block ? [{ blockId, block }] : [];
      }),
    })),
    before,
    blockIdentities: new Map(
      [...before, ...after].map((block) => [
        block.hash,
        { documentId, clientID: block.clientID, clock: block.clock },
      ]),
    ),
    afterIds: new Set(after.map((block) => block.hash)),
    afterById,
    afterDoc: draft,
  });
  expect(changedBlocks).toHaveLength(1);
  expect(changedBlocks[0].beforeBlockIdentity).toEqual({
    clientID: before[0].clientID,
    clock: before[0].clock,
  });
  expect(changedBlocks[0].afterBlockIdentity).toEqual({
    clientID: after[0].clientID,
    clock: after[0].clock,
  });
  expect(trail).toHaveLength(rows.length);
  for (const change of trail)
    expect(change).toMatchObject({
      kind: "modify",
      changeId: `receipt:document:${before[0].clientID}:${before[0].clock}`,
      beforeBlockIdentity: { documentId, clientID: before[0].clientID, clock: before[0].clock },
      afterBlockIdentity: { documentId, clientID: after[0].clientID, clock: after[0].clock },
      beforeText: before[0].serialized,
      afterTextAtReceipt: after[0].serialized,
    });
  expect(trail.map((change) => change.owner)).toEqual(
    rows.map((row) => ({ threadId: `thread-${row.id}`, turnId: row.actorTurnId })),
  );
}

function verifyTextRestoration(variant: "plain" | "bold" | "attribute" | "node") {
  const live = createDoc("base"),
    draft = cloneDoc(live);
  const target = variant === "bold" ? "**alpha**" : "alpha";
  const rows: { id: number; actorTurnId: string; updateData: Uint8Array }[] = [];
  try {
    for (const [index, markdown] of ["alpha", "beta", target].entries()) {
      draft.clientID = 300 + index;
      const updates: Uint8Array[] = [];
      const capture = (update: Uint8Array) => updates.push(update);
      draft.on("update", capture);
      try {
        draft.transact(() => {
          model.applyBlockReplacement(
            toDocHandle(draft),
            model.getBlocks(toDocHandle(draft))[0],
            codec.parse(markdown).blocks[0],
          );
          if (index === 2 && variant === "node") {
            const paragraph = unwrapBlock(model.getBlocks(toDocHandle(draft))[0]);
            paragraph.delete(0, paragraph.length);
            const text = new Y.XmlText();
            text.insert(0, "alpha");
            paragraph.insert(0, [text]);
          }
          if (index === 2 && variant === "attribute")
            unwrapBlock(model.getBlocks(toDocHandle(draft))[0]).setAttribute("align", "right");
        });
      } finally {
        draft.off("update", capture);
      }
      rows.push({
        id: index + 1,
        actorTurnId: `turn-${index + 1}`,
        updateData: Y.mergeUpdates(updates),
      });
    }
    const preview = computeDraftReviewHunks({
      liveDoc: live,
      draftDoc: draft,
      model,
      draftUpdates: rows,
    });
    expect(preview.diagnostics).toEqual([]);
    expect(new Set(preview.operations.map((op) => op.closureClassId)).size).toBe(1);
    expect(preview.operations.every((op) => op.canApplyOrDiscard !== false)).toBe(true);
    if (variant !== "plain")
      expect(
        preview.operations.find((op) => op.sourceUpdateIds.includes(3 as never)),
      ).toMatchObject({ actorTurnId: "turn-3" });
    const ids = new Set(preview.operations.flatMap((op) => op.closureUpdateIds));
    const applied = cloneDoc(live),
      discarded = cloneDoc(live);
    try {
      for (const row of rows)
        Y.applyUpdate(ids.has(row.id as never) ? applied : discarded, row.updateData);
      expect(documentEffectsEqual(applied, draft)).toBe(true);
      expect(documentEffectsEqual(discarded, live)).toBe(true);
    } finally {
      applied.destroy();
      discarded.destroy();
    }
  } finally {
    live.destroy();
    draft.destroy();
  }
}
