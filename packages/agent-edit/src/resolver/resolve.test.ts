import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import type { ResolvedEdit } from "../apply/types.js";
import { createAgentEditCodec } from "../codec-adapter.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { type ResolveWriteParams, type ResolveWriteResult, resolveWrite } from "./resolve.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodec(mdxCodec({ schema }));
const model = yProsemirrorModel(schema);

describe("resolveWrite", () => {
  it("resolves scoped find replacement to the matching live block", () => {
    const doc = createDoc("A sword.\n\nB sword.");
    const blocks = model.getBlocks(doc);
    const targetHash = model.getBlockId(blocks[1]);

    const edits = expectOk(
      resolve(doc, { command: "replace", content: "blade", find: "sword", in: targetHash }),
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "text", span: { start: 2, end: 7 }, newText: "blade" });
    expect(edits[0].kind === "text" ? edits[0].block : null).toBe(blocks[1]);
  });

  it("lowers insertion anchors to the after-block contract", () => {
    const doc = createDoc("Alpha\n\nBeta");
    const [alpha, beta] = model.getBlocks(doc);

    const beforeSecond = expectOk(
      resolve(doc, { command: "insert", content: "Inserted", before: model.getBlockId(beta) }),
    )[0];
    expect(beforeSecond).toMatchObject({ kind: "insert", newText: "Inserted" });
    expect(beforeSecond.kind === "insert" ? beforeSecond.after : null).toBe(alpha);

    const unanchored = expectOk(resolve(doc, { command: "insert", content: "End" }))[0];
    expect(unanchored.kind === "insert" ? unanchored.after : null).toBe(beta);
  });

  it("lowers cross-block serialized markdown anchors through block reconciliation", () => {
    const doc = createDoc("Alpha *starts*\n\nends *Omega*");
    const [, omega] = model.getBlocks(doc);

    const edits = expectOk(
      resolve(doc, { command: "insert", content: "!", find: "*starts*\n\nends *Omega*" }),
    );

    expect(edits.map((edit) => edit.kind)).toEqual(["text", "text"]);
    expect(edits[1]).toMatchObject({
      kind: "text",
      block: omega,
      span: { start: 0, end: "ends Omega".length },
      newText: "ends *Omega*!",
    });
  });

  it("maps one serialized inline markdown anchor to a flat-text replacement", () => {
    const doc = createDoc("He could *feel* the qi in the air now.");

    const edits = expectOk(resolve(doc, { command: "replace", content: "sense", find: "*feel*" }));

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      kind: "text",
      span: { start: 0, end: "He could feel the qi in the air now.".length },
      newText: "He could sense the qi in the air now.",
    });
  });

  it("decomposes a block range replace across text/delete/insert primitives", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const [alpha, beta, gamma] = model.getBlocks(doc);
    const range = `${model.getBlockId(alpha)}..${model.getBlockId(gamma)}`;

    const fewer = expectOk(resolve(doc, { command: "replace", content: "One", in: range }));
    expect(fewer.map((edit) => edit.kind)).toEqual(["text", "delete", "delete"]);
    expect(fewer[0].kind === "text" ? fewer[0].block : null).toBe(alpha);
    expect(fewer[1].kind === "delete" ? fewer[1].block : null).toBe(beta);

    const more = expectOk(
      resolve(createDoc("Alpha\n\nBeta"), {
        command: "replace",
        content: "One\n\nTwo\n\nThree",
        in: rangeFor("Alpha\n\nBeta"),
      }),
    );
    expect(more.map((edit) => edit.kind)).toEqual(["text", "text", "insert"]);
  });

  it("matches find text with NFC normalization while preserving original spans", () => {
    const doc = createDoc("cafe\u0301 sword");

    const edits = expectOk(resolve(doc, { command: "replace", content: "tea", find: "café" }));

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "text", span: { start: 0, end: 5 }, newText: "tea" });
  });

  it("scopes find-based writes to the around window", () => {
    const doc = createDoc(aroundNeedleDoc());
    const blocks = model.getBlocks(doc);
    const around = model.getBlockId(blocks[4]);

    const replace = expectOk(
      resolve(doc, { command: "replace", content: "changed", find: "needle", around }),
    );

    expect(replace).toHaveLength(1);
    expect(replace[0]).toMatchObject({ kind: "text", block: blocks[4] });
  });

  it("returns representative resolution errors", () => {
    const doc = createDoc("sword one\n\nsword two");
    const [first, second] = model.getBlocks(doc);

    expect(resolve(doc, { command: "replace", content: "blade", find: "sword" })).toMatchObject({
      ok: false,
      error: { code: "ambiguous_match", details: { count: 2 } },
    });
    expect(resolve(doc, { command: "replace", content: "blade", find: "" })).toMatchObject({
      ok: false,
      error: { code: "invalid_write" },
    });
    expect(resolve(doc, { command: "insert", content: "x", after: "deadbeef" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(
      resolve(doc, {
        command: "replace",
        content: "x",
        in: `${model.getBlockId(second)}..${model.getBlockId(first)}`,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_write" } });
  });
});

function createDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const parsed = codec.parse(markdown);
  const root = schema.node("doc", null, parsed.blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return doc;
}

function rangeFor(markdown: string): string {
  const doc = createDoc(markdown);
  const blocks = model.getBlocks(doc);
  const first = blocks[0];
  const last = blocks.at(-1);
  if (!first || !last) throw new Error("expected blocks");
  return `${model.getBlockId(first)}..${model.getBlockId(last)}`;
}

function aroundNeedleDoc(): string {
  return [
    "Block 1 needle",
    "Block 2",
    "Block 3",
    "Block 4",
    "Block 5 needle",
    "Block 6",
    "Block 7",
    "Block 8",
    "Block 9 needle",
  ].join("\n\n");
}

function resolve(
  doc: Y.Doc,
  params: Omit<ResolveWriteParams, "documentAddress">,
): ResolveWriteResult {
  return resolveWrite(
    { doc, model, codec },
    {
      documentAddress: {
        documentId: "123e4567-e89b-12d3-a456-426614174000",
        filePath: "chapter.md",
      },
      ...params,
    },
  );
}

function expectOk(result: ResolveWriteResult): ResolvedEdit[] {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.message);
  return result.edits;
}
