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

  it("defaults unanchored inserts to after the last block", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const [alpha, , gamma] = model.getBlocks(doc);

    const noAnchor = expectOk(resolve(doc, { command: "insert", content: "Delta\n\nEpsilon" }));
    expect(noAnchor).toHaveLength(1);
    expect(noAnchor[0]).toMatchObject({ kind: "insert", newText: "Delta\n\nEpsilon" });
    expect(noAnchor[0].kind === "insert" ? noAnchor[0].after : null).toBe(gamma);

    const beforeFirst = expectOk(
      resolve(doc, { command: "insert", content: "Start", before: model.getBlockId(alpha) }),
    );
    expect(beforeFirst).toHaveLength(1);
    expect(beforeFirst[0].kind === "insert" ? beforeFirst[0].after : "unexpected").toBeUndefined();

    const afterLast = expectOk(
      resolve(doc, { command: "insert", content: "End", after: model.getBlockId(gamma) }),
    );
    expect(afterLast).toHaveLength(1);
    expect(afterLast[0].kind === "insert" ? afterLast[0].after : null).toBe(gamma);

    const emptyDocInsert = expectOk(
      resolve(createEmptyDoc(), { command: "insert", content: "Only" }),
    );
    expect(emptyDocInsert).toHaveLength(1);
    expect(
      emptyDocInsert[0].kind === "insert" ? emptyDocInsert[0].after : "unexpected",
    ).toBeUndefined();
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

  it("maps cross-block serialized markdown anchors to the insertion boundary", () => {
    const doc = createDoc("Alpha *starts*\n\nends *Omega*");
    const [, omega] = model.getBlocks(doc);

    const edits = expectOk(
      resolve(doc, { command: "insert", content: "!", find: "*starts*\n\nends *Omega*" }),
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      kind: "text",
      element: omega,
      span: { start: "ends Omega".length, end: "ends Omega".length },
      newText: "!",
    });
  });

  it("decomposes two-block find replacements into boundary text plus structural delete", () => {
    const doc = createDoc("Alpha starts\n\nends Omega");
    const [alpha, omega] = model.getBlocks(doc);

    const edits = expectOk(
      resolve(doc, { command: "replace", content: "middle", find: "starts\n\nends" }),
    );

    expect(edits.map((edit) => edit.kind)).toEqual(["text", "delete"]);
    expect(edits[0]).toMatchObject({
      kind: "text",
      element: alpha,
      span: { start: 0, end: "Alpha starts".length },
      newText: "Alpha middle Omega",
    });
    expect(edits[1].kind === "delete" ? edits[1].element : null).toBe(omega);
  });

  it("decomposes three-block find deletion into boundary text plus middle deletes", () => {
    const doc = createDoc("Before X\n\nMiddle\n\nY After");
    const [before, middle, after] = model.getBlocks(doc);

    const edits = expectOk(
      resolve(doc, { command: "replace", content: "", find: "X\n\nMiddle\n\nY" }),
    );

    expect(edits.map((edit) => edit.kind)).toEqual(["text", "delete", "delete"]);
    expect(edits[0]).toMatchObject({
      kind: "text",
      element: before,
      span: { start: 0, end: "Before X".length },
      newText: "Before  After",
    });
    expect(edits[1].kind === "delete" ? edits[1].element : null).toBe(middle);
    expect(edits[2].kind === "delete" ? edits[2].element : null).toBe(after);
  });

  it("maps serialized italic anchors to flat text replace spans", () => {
    const doc = createDoc("Not burning — *thrumming.* Alive.");

    const edits = expectOk(
      resolve(doc, {
        command: "replace",
        content: "Not burning — humming. Alive.",
        find: "Not burning — *thrumming.* Alive.",
      }),
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      kind: "text",
      span: { start: 0, end: "Not burning — thrumming. Alive.".length },
      newText: "Not burning — humming. Alive.",
    });
  });

  it("maps serialized inline markdown anchors in the middle of prose", () => {
    const source =
      "He could *feel* the qi in the air now — not as a vague warmth, but as a current.";
    const doc = createDoc(source);

    const edits = expectOk(
      resolve(doc, {
        command: "replace",
        content: "sense",
        find: "*feel*",
      }),
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      kind: "text",
      span: { start: "He could ".length, end: "He could feel".length },
      newText: "sense",
    });
  });

  it("maps bold, inline-code, and mixed serialized anchors", () => {
    const doc = createDoc("A **bold** word, `code()`, and **bold *nested*** end.");

    const bold = expectOk(
      resolve(doc, { command: "replace", content: "strong", find: "**bold**" }),
    );
    expect(bold[0]).toMatchObject({
      kind: "text",
      span: { start: "A ".length, end: "A bold".length },
      newText: "strong",
    });

    const code = expectOk(resolve(doc, { command: "insert", content: "!", find: "`code()`" }));
    expect(code[0]).toMatchObject({
      kind: "text",
      span: { start: "A bold word, code()".length, end: "A bold word, code()".length },
      newText: "!",
    });

    const mixed = expectOk(
      resolve(doc, { command: "replace", content: "layered", find: "**bold *nested***" }),
    );
    expect(mixed[0]).toMatchObject({
      kind: "text",
      span: {
        start: "A bold word, code(), and ".length,
        end: "A bold word, code(), and bold nested".length,
      },
      newText: "layered",
    });
  });

  it("keeps serialized markdown anchors ambiguous when they appear more than once", () => {
    const doc = createDoc("A *word* here.\n\nA *word* there.");

    expect(resolve(doc, { command: "replace", content: "term", find: "*word*" })).toMatchObject({
      ok: false,
      error: { code: "ambiguous_match", details: { count: 2 } },
    });
  });

  it("still maps plain-text anchors containing em dashes", () => {
    const doc = createDoc("Plain text — no markers.");

    const edits = expectOk(
      resolve(doc, {
        command: "replace",
        content: "Plain text — changed.",
        find: "Plain text — no markers.",
      }),
    );

    expect(edits[0]).toMatchObject({
      kind: "text",
      span: { start: 0, end: "Plain text — no markers.".length },
      newText: "Plain text — changed.",
    });
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

  it("scopes find-based writes to the around window", () => {
    const doc = createDoc(aroundNeedleDoc());
    const blocks = model.getBlocks(doc);
    const around = model.getBlockId(blocks[4]);

    const replace = expectOk(
      resolve(doc, { command: "replace", content: "changed", find: "needle", around }),
    );
    expect(replace).toHaveLength(1);
    expect(replace[0]).toMatchObject({
      kind: "text",
      element: blocks[4],
      span: { start: "Block 5 ".length, end: "Block 5 needle".length },
      newText: "changed",
    });

    const insert = expectOk(
      resolve(doc, { command: "insert", content: "!", find: "needle", around }),
    );
    expect(insert).toHaveLength(1);
    expect(insert[0]).toMatchObject({
      kind: "text",
      element: blocks[4],
      span: { start: "Block 5 needle".length, end: "Block 5 needle".length },
      newText: "!",
    });
  });

  it("rejects invalid around scope combinations", () => {
    const doc = createDoc("Alpha needle\n\nBeta needle");
    const blocks = model.getBlocks(doc);
    const firstHash = model.getBlockId(blocks[0]);
    const secondHash = model.getBlockId(blocks[1]);

    expect(
      resolve(doc, {
        command: "replace",
        content: "changed",
        find: "needle",
        in: firstHash,
        around: secondHash,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invalid_write",
        message: "`in` and `around` are mutually exclusive scope parameters",
      },
    });
    expect(
      resolve(doc, {
        command: "insert",
        content: "!",
        find: "needle",
        in: firstHash,
        around: secondHash,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invalid_write",
        message: "`in` and `around` are mutually exclusive scope parameters",
      },
    });
    expect(
      resolve(doc, { command: "replace", content: "changed", around: firstHash }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invalid_write",
        message: "`around` only scopes find-based replace commands",
      },
    });
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

function createEmptyDoc(): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  return doc;
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
