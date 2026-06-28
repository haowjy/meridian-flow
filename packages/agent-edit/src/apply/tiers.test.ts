// Behavioral coverage for tier routing, update replay fidelity, and echo.

import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { createAgentEditCodec } from "../codec-adapter.js";
import type { BlockRef } from "../handles.js";
import { toRef } from "../handles.js";
import { type YProsemirrorDocumentModel, yProsemirrorModel } from "../model/y-prosemirror.js";
import { applyConcurrentUpdates, computeEcho, snapshotBlocks } from "./echo.js";
import { applyEdits } from "./tiers.js";
import type { AgentOrigin, ApplyResult, ApplyTier, ResolvedEdit } from "./types.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodec(mdxCodec({ schema }));
const baseModel = yProsemirrorModel(schema);
const origin: AgentOrigin = { type: "agent", actorTurnId: "turn-1" };

describe("applyEdits tier routing", () => {
  it("routes plain text within one mark context to Tier 1", () => {
    const doc = createDoc("Alpha sword.");
    const { model, calls } = recordingModel();
    const [block] = model.getBlocks(doc);

    const result = applyEdits(
      doc,
      model,
      codec,
      textEdit(block, { start: 6, end: 11 }, "blade"),
      origin,
    );

    expectOk(result);
    expect(calls).toEqual([1]);
    expect(result.ok && result.appliedEdits?.map((edit) => edit.tier)).toEqual([1]);
    expect(model.getText(block)).toBe("Alpha blade.");
    const blockHash = model.getBlockId(block);
    expect(result.ok && result.echo).toEqual([
      { mode: "full", blocks: [`${blockHash}|Alpha blade.`] },
    ]);
    expectNoOrphanedElements(doc);
  });

  it("routes text-only edits inside an existing mark run to Tier 1 and preserves marks", () => {
    const doc = createDoc("Alpha **sword**.");
    const { model, calls } = recordingModel();
    const [block] = model.getBlocks(doc);

    const result = applyEdits(
      doc,
      model,
      codec,
      textEdit(block, { start: 6, end: 11 }, "blade"),
      origin,
    );

    expectOk(result);
    expect(calls).toEqual([1]);
    expect(result.ok && result.appliedEdits?.map((edit) => edit.tier)).toEqual([1]);
    expect(model.serializeBlockBodies(doc, codec, [block]).join("")).toBe("Alpha **blade**.");
    expectNoOrphanedElements(doc);
  });

  it("routes formatting changes to Tier 2", () => {
    const doc = createDoc("Alpha sword.");
    const { model, calls } = recordingModel();
    const [block] = model.getBlocks(doc);

    const result = applyEdits(
      doc,
      model,
      codec,
      textEdit(block, { start: 6, end: 11 }, "**blade**"),
      origin,
    );

    expectOk(result);
    expect(calls).toEqual([2]);
    expect(result.ok && result.appliedEdits?.map((edit) => edit.tier)).toEqual([2]);
    expect(model.serializeBlockBodies(doc, codec, [block]).join("")).toBe("Alpha **blade**.");
    expectNoOrphanedElements(doc);
  });

  it("routes mark-boundary-crossing text edits to Tier 2", () => {
    const doc = createDoc("A **bold** plain");
    const { model, calls } = recordingModel();
    const [block] = model.getBlocks(doc);

    const result = applyEdits(
      doc,
      model,
      codec,
      textEdit(block, { start: 5, end: 8 }, "X"),
      origin,
    );

    expectOk(result);
    expect(calls).toEqual([2]);
    expect(result.ok && result.appliedEdits?.map((edit) => edit.tier)).toEqual([2]);
    expect(model.getText(block)).toBe("A bolXlain");
    expectNoOrphanedElements(doc);
  });

  it("routes inserts and deletes to Tier 3", () => {
    const doc = createDoc("Alpha\n\nBeta");
    const { model, calls } = recordingModel();
    const [alpha, beta] = model.getBlocks(doc);

    const insert = applyEdits(
      doc,
      model,
      codec,
      {
        documentId: "doc-1",
        file: "chapter.md",
        kind: "insert",
        after: toRef(alpha),
        newText: "Inserted",
      },
      origin,
    );
    expectOk(insert);

    const del = applyEdits(
      doc,
      model,
      codec,
      { documentId: "doc-1", file: "chapter.md", kind: "delete", block: toRef(beta) },
      origin,
    );
    expectOk(del);

    expect(calls).toEqual([3, 3]);
    expect(insert.ok && insert.appliedEdits?.map((edit) => edit.tier)).toEqual([3]);
    expect(del.ok && del.appliedEdits?.map((edit) => edit.tier)).toEqual([3]);
    expect(blockTexts(doc)).toEqual(["Alpha", "Inserted"]);
    expectNoOrphanedElements(doc);
  });
});

describe("applyEdits update fidelity", () => {
  it.each([
    [
      "Tier 1 text",
      "Alpha sword.",
      (doc: Y.Doc) => textEdit(baseModel.getBlocks(doc)[0], { start: 6, end: 11 }, "blade"),
      1,
    ],
    [
      "Tier 2 formatting",
      "Alpha sword.",
      (doc: Y.Doc) => textEdit(baseModel.getBlocks(doc)[0], { start: 6, end: 11 }, "**blade**"),
      2,
    ],
    [
      "Tier 3 insert",
      "Alpha\n\nBeta",
      (doc: Y.Doc): ResolvedEdit => ({
        documentId: "doc-1",
        file: "chapter.md",
        kind: "insert",
        after: toRef(baseModel.getBlocks(doc)[0]),
        newText: "Inserted",
      }),
      3,
    ],
    [
      "Tier 3 delete",
      "Alpha\n\nBeta",
      (doc: Y.Doc): ResolvedEdit => ({
        documentId: "doc-1",
        file: "chapter.md",
        kind: "delete",
        block: toRef(baseModel.getBlocks(doc)[1]),
      }),
      3,
    ],
  ] satisfies Array<
    [string, string, (doc: Y.Doc) => ResolvedEdit, ApplyTier]
  >)("replays %s update bytes into an identical fresh doc", (_name, markdown, makeEdit, tier) => {
    const doc = createDoc(markdown, 1);
    doc.clientID = 2;
    const fresh = cloneDoc(doc, 9);
    const prevVector = Y.encodeStateVector(doc);

    const result = applyEdits(doc, baseModel, codec, makeEdit(doc), origin);

    expectOk(result);
    expect(result.ok && result.appliedEdits?.[0]?.tier).toBe(tier);
    const update = Y.encodeStateAsUpdate(doc, prevVector);
    Y.applyUpdate(fresh, update);
    expect(documentJson(fresh)).toEqual(documentJson(doc));
    expectNoOrphanedElements(doc);
  });

  it("uses the explicit agent origin for local transactions", () => {
    const doc = createDoc("Alpha sword.");
    const [block] = baseModel.getBlocks(doc);
    const origins: unknown[] = [];
    doc.on("afterTransaction", (transaction) => origins.push(transaction.origin));

    const result = applyEdits(
      doc,
      baseModel,
      codec,
      textEdit(block, { start: 6, end: 11 }, "blade"),
      origin,
    );

    expectOk(result);
    expect(origins).toContain(origin);
  });
});

describe("applyEdits preflight safety", () => {
  it("detects same-turn references to a deleted block before mutating", () => {
    const doc = createDoc("Alpha\n\nBeta");
    const [alpha] = baseModel.getBlocks(doc);
    const before = documentJson(doc);

    const result = applyEdits(
      doc,
      baseModel,
      codec,
      [
        { documentId: "doc-1", file: "chapter.md", kind: "delete", block: toRef(alpha) },
        textEdit(alpha, { start: 0, end: 5 }, "Changed"),
      ],
      origin,
    );

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(documentJson(doc)).toEqual(before);
  });

  it("applies multiple same-block Tier 1 replacements back-to-front", () => {
    const doc = createDoc("sword and sword");
    const [block] = baseModel.getBlocks(doc);

    const result = applyEdits(
      doc,
      baseModel,
      codec,
      [
        textEdit(block, { start: 0, end: 5 }, "axe"),
        textEdit(block, { start: 10, end: 15 }, "axe"),
      ],
      origin,
    );

    expectOk(result);
    expect(blockTexts(doc)).toEqual(["axe and axe"]);
  });
});

describe("applyEdits echo and concurrent edits", () => {
  it("echoes the agent window and lists a non-overlapping concurrent human edit", () => {
    const live = createDoc("Alpha sword.\n\nBeta waits.\n\nGamma waits.\n\nDelta waits.", 1);
    const local = cloneDoc(live, 2);
    const syncStateVector = Y.encodeStateVector(local);
    const localBlocks = baseModel.getBlocks(local);
    const alphaHash = baseModel.getBlockId(localBlocks[0]);
    const betaHash = baseModel.getBlockId(localBlocks[1]);
    const remoteHash = baseModel.getBlockId(localBlocks[3]);
    const remoteUpdate = remoteTextUpdate(live, 3, { from: 0, to: 5 }, "Omega", {
      type: "human",
      userId: "user-1",
    });
    const [localAlpha] = baseModel.getBlocks(local);

    const result = applyEdits(
      local,
      baseModel,
      codec,
      textEdit(localAlpha, { start: 6, end: 11 }, "blade"),
      origin,
      {
        syncStateVector,
        concurrentUpdates: [{ update: remoteUpdate, origin: { type: "human", userId: "user-1" } }],
      },
    );

    expectOk(result);
    expect(result.ok && result.concurrentEdits?.human).toEqual([remoteHash]);
    expect(result.ok && result.echo).toEqual([
      { mode: "full", blocks: [`${alphaHash}|Alpha blade.`] },
      { mode: "truncated", blocks: [`${betaHash}|Beta waits.`] },
    ]);
    expect(blockTexts(local)).toEqual([
      "Alpha blade.",
      "Beta waits.",
      "Gamma waits.",
      "Omega waits.",
    ]);
    expectNoOrphanedElements(local);
  });

  it("shows a full echo when a concurrent human edit touches the agent hunk", () => {
    const live = createDoc("Alpha sword.\n\nBeta waits.", 1);
    const local = cloneDoc(live, 2);
    const syncStateVector = Y.encodeStateVector(local);
    const [localAlpha] = baseModel.getBlocks(local);
    const alphaHash = baseModel.getBlockId(localAlpha);
    const remoteUpdate = remoteTextUpdate(live, 0, { from: 6, to: 11 }, "knife", {
      type: "human",
      userId: "user-1",
    });

    const result = applyEdits(
      local,
      baseModel,
      codec,
      textEdit(localAlpha, { start: 6, end: 11 }, "blade"),
      origin,
      {
        syncStateVector,
        concurrentUpdates: [{ update: remoteUpdate, origin: { type: "human", userId: "user-1" } }],
      },
    );

    expectOk(result);
    expect(result.ok && result.concurrentEdits?.human).toEqual([alphaHash]);
    expect(result.ok && result.echo).toHaveLength(2);
    expect(result.ok && result.echo[0]?.mode).toBe("full");
    expect(result.ok && result.echo[1]?.mode).toBe("truncated");
    expect(
      result.ok && result.echo[0]?.blocks.some((line) => line.startsWith(`${alphaHash}|`)),
    ).toBe(true);
    expectNoOrphanedElements(local);
  });
});

describe("applyConcurrentUpdates rendered concurrent blocks", () => {
  it("includes the current read-format line for a changed human block", () => {
    const live = createDoc("Alpha sword.\n\nBeta waits.", 1);
    const local = cloneDoc(live, 2);
    const syncStateVector = Y.encodeStateVector(local);
    const update = remoteTextUpdate(live, 0, { from: 6, to: 11 }, "knife", {
      type: "human",
      userId: "user-1",
    });

    const result = applyConcurrentUpdates(
      local,
      baseModel,
      codec,
      [{ update, origin: { type: "human", userId: "user-1" } }],
      origin,
      syncStateVector,
    );
    const changedLine = snapshotBlocks(local, baseModel, codec).find((block) =>
      block.serialized.endsWith("|Alpha knife."),
    )?.serialized;

    expect(result.info?.renderedBlocks?.human).toEqual([changedLine]);
  });

  it("includes the read-format line for an inserted human block", () => {
    const live = createDoc("Alpha sword.", 1);
    const local = cloneDoc(live, 2);
    const syncStateVector = Y.encodeStateVector(local);
    const update = remoteInsertUpdate(live, 0, "Beta arrives.", {
      type: "human",
      userId: "user-1",
    });

    const result = applyConcurrentUpdates(
      local,
      baseModel,
      codec,
      [{ update, origin: { type: "human", userId: "user-1" } }],
      origin,
      syncStateVector,
    );
    const insertedLine = snapshotBlocks(local, baseModel, codec).find((block) =>
      block.serialized.endsWith("|Beta arrives."),
    )?.serialized;

    expect(result.info?.renderedBlocks?.human).toEqual([insertedLine]);
  });

  it("uses a minimal marker for a deleted human block", () => {
    const live = createDoc("Alpha sword.\n\nBeta waits.", 1);
    const local = cloneDoc(live, 2);
    const syncStateVector = Y.encodeStateVector(local);
    const deletedHash = baseModel.getBlockId(baseModel.getBlocks(local)[1]);
    const update = remoteDeleteUpdate(live, 1, { type: "human", userId: "user-1" });

    const result = applyConcurrentUpdates(
      local,
      baseModel,
      codec,
      [{ update, origin: { type: "human", userId: "user-1" } }],
      origin,
      syncStateVector,
    );

    expect(result.info?.renderedBlocks?.human).toEqual([`${deletedHash}| (deleted)`]);
  });

  it("omits rendered blocks when the concurrent summary is collapsed", () => {
    const live = createDoc("Alpha sword.\n\nBeta waits.", 1);
    const local = cloneDoc(live, 2);
    const syncStateVector = Y.encodeStateVector(local);
    const update = remoteMultiTextUpdate(
      live,
      [
        [0, { from: 0, to: 5 }, "Omega"],
        [1, { from: 0, to: 4 }, "Gamma"],
      ],
      { type: "human", userId: "user-1" },
    );

    const result = applyConcurrentUpdates(
      local,
      baseModel,
      codec,
      [{ update, origin: { type: "human", userId: "user-1" } }],
      origin,
      syncStateVector,
      1,
    );

    expect(result.info).toEqual({
      human: ["*"],
      agent: [],
      collapsed: true,
      reviewCommand: 'write(command="read", file="<current>")',
    });
  });

  it("ignores the acting agent's own updates", () => {
    const live = createDoc("Alpha sword.", 1);
    const local = cloneDoc(live, 2);
    const syncStateVector = Y.encodeStateVector(local);
    const update = remoteTextUpdate(live, 0, { from: 6, to: 11 }, "knife", origin);

    const result = applyConcurrentUpdates(
      local,
      baseModel,
      codec,
      [{ update, origin }],
      origin,
      syncStateVector,
    );

    expect(result.info).toBeUndefined();
    expect(result.touchedHashes).toEqual(new Set());
  });
});

describe("computeEcho", () => {
  it("deduplicates overlapping windows in document order before tiering", () => {
    const before = [
      block("A", "ctx0"),
      block("B", "old1"),
      block("X", "deleted"),
      block("C", "ctx2"),
      block("D", "old3"),
      block("E", "ctx4"),
    ];
    const after = [
      block("A", "ctx0"),
      block("B", "new1"),
      block("C", "ctx2"),
      block("D", "new3"),
      block("E", "ctx4"),
    ];

    const echo = computeEcho({
      before,
      after,
      agentTouchedHashes: new Set(["B", "D"]),
      agentDeletedHashes: new Set(["X"]),
    });
    const lines = echo.flatMap((hunk) => hunk.blocks);

    expect(lines).toEqual(["A|ctx0", "B|new1", "C|ctx2", "D|new3", "E|ctx4"]);
    expect(lines.map((line) => line.split("|")[0])).toEqual(["A", "B", "C", "D", "E"]);
    expect(new Set(lines.map((line) => line.split("|")[0])).size).toBe(lines.length);
    expect(echo.map((hunk) => hunk.mode)).toEqual([
      "truncated",
      "full",
      "truncated",
      "full",
      "truncated",
    ]);
  });

  it("truncates unchanged in-window context to the first eight words", () => {
    const longContext = "one two three four five six seven eight nine ten";
    const shortContext = "short context stays unchanged";
    const before = [block("A", longContext), block("B", "old center"), block("C", shortContext)];
    const after = [block("A", longContext), block("B", "new center"), block("C", shortContext)];

    const echo = computeEcho({
      before,
      after,
      agentTouchedHashes: new Set(["B"]),
      agentDeletedHashes: new Set(),
    });

    expect(echo).toEqual([
      { mode: "truncated", blocks: ["A|one two three four five six seven eight..."] },
      { mode: "full", blocks: ["B|new center"] },
      { mode: "truncated", blocks: ["C|short context stays unchanged"] },
    ]);
  });
});

function block(hash: string, body: string) {
  return { hash, serialized: `${hash}|${body}` };
}

function createDoc(markdown: string, clientID = 1): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const parsed = codec.parse(markdown);
  const root = schema.node("doc", null, parsed.blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return doc;
}

function cloneDoc(source: Y.Doc, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  doc.clientID = clientID;
  return doc;
}

function textEdit(
  element: BlockRef,
  span: { start: number; end: number },
  newText: string,
): ResolvedEdit {
  return {
    documentId: "doc-1",
    file: "chapter.md",
    kind: "text",
    block: toRef(element),
    span,
    newText,
  };
}

function recordingModel(): { model: YProsemirrorDocumentModel; calls: ApplyTier[] } {
  const calls: ApplyTier[] = [];
  const base = yProsemirrorModel(schema);
  return {
    calls,
    model: {
      ...base,
      applyTextEdit(doc, block, span, newText) {
        calls.push(1);
        base.applyTextEdit(doc, block, span, newText);
      },
      applyInlineReplacement(doc, block, span, replacementMarkup, codec) {
        calls.push(2);
        return base.applyInlineReplacement(doc, block, span, replacementMarkup, codec);
      },
      insertBlocks(doc, after, parsed) {
        calls.push(3);
        return base.insertBlocks(doc, after, parsed);
      },
      deleteBlock(doc, block) {
        calls.push(3);
        base.deleteBlock(doc, block);
      },
    },
  };
}

function remoteTextUpdate(
  doc: Y.Doc,
  blockIndex: number,
  span: { from: number; to: number },
  newText: string,
  transactionOrigin: unknown,
): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const block = baseModel.getBlocks(doc)[blockIndex];
  doc.transact(() => baseModel.applyTextEdit(doc, block, span, newText), transactionOrigin);
  return Y.encodeStateAsUpdate(doc, before);
}

function remoteMultiTextUpdate(
  doc: Y.Doc,
  edits: Array<[number, { from: number; to: number }, string]>,
  transactionOrigin: unknown,
): Uint8Array {
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    for (const [blockIndex, span, newText] of edits) {
      const block = baseModel.getBlocks(doc)[blockIndex];
      baseModel.applyTextEdit(doc, block, span, newText);
    }
  }, transactionOrigin);
  return Y.encodeStateAsUpdate(doc, before);
}

function remoteInsertUpdate(
  doc: Y.Doc,
  afterBlockIndex: number,
  markdown: string,
  transactionOrigin: unknown,
): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const after = baseModel.getBlocks(doc)[afterBlockIndex];
  const parsed = codec.parse(markdown);
  doc.transact(() => baseModel.insertBlocks(doc, after, parsed), transactionOrigin);
  return Y.encodeStateAsUpdate(doc, before);
}

function remoteDeleteUpdate(
  doc: Y.Doc,
  blockIndex: number,
  transactionOrigin: unknown,
): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const block = baseModel.getBlocks(doc)[blockIndex];
  doc.transact(() => baseModel.deleteBlock(doc, block), transactionOrigin);
  return Y.encodeStateAsUpdate(doc, before);
}

function blockTexts(doc: Y.Doc): string[] {
  return baseModel.getBlocks(doc).map((block) => baseModel.getText(block));
}

function documentJson(doc: Y.Doc): unknown {
  return schema.node("doc", null, baseModel.projectBlocks(doc)).toJSON();
}

function expectOk(result: ApplyResult): asserts result is Extract<ApplyResult, { ok: true }> {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.message);
}

function expectNoOrphanedElements(doc: Y.Doc): void {
  const reachable = new Set<Y.XmlElement>();
  const visit = (value: Y.XmlElement | Y.XmlFragment | Y.XmlText) => {
    if (value instanceof Y.XmlElement) reachable.add(value);
    if (value instanceof Y.XmlText) return;
    for (const child of value.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
    }
  };
  visit(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));

  for (const element of liveXmlElementsInStore(doc)) {
    expect(reachable.has(element)).toBe(true);
  }
}

function liveXmlElementsInStore(doc: Y.Doc): Y.XmlElement[] {
  const elements: Y.XmlElement[] = [];
  const store = (doc as unknown as { store: { clients: Map<number, unknown[]> } }).store;
  for (const structs of store.clients.values()) {
    for (const struct of structs) {
      const item = struct as { deleted?: boolean; content?: { type?: unknown } };
      if (item.deleted === true) continue;
      const type = item.content?.type;
      if (type instanceof Y.XmlElement) elements.push(type);
    }
  }
  return elements;
}
