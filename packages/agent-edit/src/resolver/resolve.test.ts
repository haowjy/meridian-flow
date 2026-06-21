import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import type { ResolvedEdit } from "../apply/types.js";
import { mdxCodec } from "../codec/presets/mdx.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { type ResolveWriteParams, type ResolveWriteResult, resolveWrite } from "./resolve.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);

describe("resolveWrite", () => {
  it("resolves replace(find, in) to the matching live Y.XmlElement", () => {
    const doc = createDoc("A sword.\n\nB sword.");
    const blocks = model.getBlocks(doc);
    const targetHash = model.getBlockId(blocks[1]);

    const result = resolve(doc, {
      command: "replace",
      content: "blade",
      find: "sword",
      in: targetHash,
    });

    const edits = expectOk(result);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "text", span: { start: 2, end: 7 }, newText: "blade" });
    expect(edits[0].kind === "text" ? edits[0].element : null).toBe(blocks[1]);
  });

  it("lowers before to the predecessor after reference", () => {
    const doc = createDoc("Alpha\n\nBeta");
    const [alpha, beta] = model.getBlocks(doc);

    const beforeSecond = expectOk(
      resolve(doc, { command: "insert", content: "Inserted", before: model.getBlockId(beta) }),
    )[0];
    expect(beforeSecond).toMatchObject({ kind: "insert", newText: "Inserted" });
    expect(beforeSecond.kind === "insert" ? beforeSecond.after : null).toBe(alpha);

    const beforeFirst = expectOk(
      resolve(doc, { command: "insert", content: "Start", before: model.getBlockId(alpha) }),
    )[0];
    expect(beforeFirst.kind).toBe("insert");
    expect(beforeFirst.kind === "insert" ? beforeFirst.after : "unexpected").toBeUndefined();
  });

  it("decomposes all=true find matches left-to-right", () => {
    const doc = createDoc("sword one\n\nsword two");
    const blocks = model.getBlocks(doc);

    const edits = expectOk(
      resolve(doc, { command: "replace", content: "blade", find: "sword", all: true }),
    );

    expect(edits).toHaveLength(2);
    expect(edits.map((edit) => edit.kind)).toEqual(["text", "text"]);
    expect(edits[0].kind === "text" ? edits[0].element : null).toBe(blocks[0]);
    expect(edits[1].kind === "text" ? edits[1].element : null).toBe(blocks[1]);
  });

  it("matches find text with NFC normalization while preserving original spans", () => {
    const doc = createDoc("cafe\u0301 sword");

    const edits = expectOk(resolve(doc, { command: "replace", content: "tea", find: "café" }));

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "text", span: { start: 0, end: 5 }, newText: "tea" });
  });

  it("decomposes range replace when new content has more blocks", () => {
    const doc = createDoc("Alpha\n\nBeta");
    const [alpha, beta] = model.getBlocks(doc);
    const range = `${model.getBlockId(alpha)}..${model.getBlockId(beta)}`;

    const edits = expectOk(
      resolve(doc, { command: "replace", content: "One\n\nTwo\n\nThree", in: range }),
    );

    expect(edits.map((edit) => edit.kind)).toEqual(["text", "text", "insert"]);
    expect(edits[0]).toMatchObject({ kind: "text", newText: "One" });
    expect(edits[1]).toMatchObject({ kind: "text", newText: "Two" });
    expect(edits[0].kind === "text" ? edits[0].element : null).toBe(alpha);
    expect(edits[1].kind === "text" ? edits[1].element : null).toBe(beta);
    expect(edits[2].kind === "insert" ? edits[2].after : null).toBe(beta);
    expect(edits[2]).toMatchObject({ kind: "insert", newText: "Three" });
  });

  it("decomposes range replace when new content has fewer blocks", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const [alpha, beta, gamma] = model.getBlocks(doc);
    const range = `${model.getBlockId(alpha)}..${model.getBlockId(gamma)}`;

    const edits = expectOk(resolve(doc, { command: "replace", content: "One", in: range }));

    expect(edits.map((edit) => edit.kind)).toEqual(["text", "delete", "delete"]);
    expect(edits[0].kind === "text" ? edits[0].element : null).toBe(alpha);
    expect(edits[1].kind === "delete" ? edits[1].element : null).toBe(beta);
    expect(edits[2].kind === "delete" ? edits[2].element : null).toBe(gamma);
  });

  it("resolves content-empty deletion rules", () => {
    const doc = createDoc("Alpha sword.\n\nBeta");
    const [alpha, beta] = model.getBlocks(doc);
    const range = `${model.getBlockId(alpha)}..${model.getBlockId(beta)}`;

    const blockDelete = expectOk(resolve(doc, { command: "replace", content: "", in: range }));
    expect(blockDelete.map((edit) => edit.kind)).toEqual(["delete", "delete"]);

    const textDelete = expectOk(resolve(doc, { command: "replace", content: "", find: "sword" }));
    expect(textDelete).toHaveLength(1);
    expect(textDelete[0]).toMatchObject({ kind: "text", newText: "", span: { start: 6, end: 11 } });

    const invalidInsert = resolve(doc, { command: "insert", content: "" });
    expect(invalidInsert).toMatchObject({ ok: false, error: { code: "invalid_write" } });
  });

  it("scopes find to heading sections by slug and heading hash", () => {
    const doc = createDoc("# Arena\n\nsword here\n\n# After\n\nsword there");
    const [arenaHeading, arenaParagraph] = model.getBlocks(doc);

    const bySlug = expectOk(
      resolve(doc, { command: "replace", content: "blade", find: "sword", in: "#arena" }),
    );
    expect(bySlug[0].kind === "text" ? bySlug[0].element : null).toBe(arenaParagraph);

    const byHash = expectOk(
      resolve(doc, {
        command: "replace",
        content: "blade",
        find: "sword",
        in: `#${model.getBlockId(arenaHeading)}`,
      }),
    );
    expect(byHash[0].kind === "text" ? byHash[0].element : null).toBe(arenaParagraph);
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

function resolve(
  doc: Y.Doc,
  params: Omit<ResolveWriteParams, "documentId" | "file">,
): ResolveWriteResult {
  return resolveWrite(
    { doc, model, codec },
    { documentId: "doc-1", file: "chapter.md", ...params },
  );
}

function expectOk(result: ResolveWriteResult): ResolvedEdit[] {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error.message);
  return result.edits;
}
