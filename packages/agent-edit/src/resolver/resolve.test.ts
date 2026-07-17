import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import type { ResolvedEdit } from "../apply/types.js";
import { createAgentEditCodec } from "../codec-adapter.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { type ResolveWriteParams, type ResolveWriteResult, resolveWrite } from "./resolve.js";
import { resolveScope } from "./scope.js";
import { collisionMarkdown, prefixCollisionFixture } from "./test-support/hash-collision.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodec(
  mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
);
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
    expect(resolve(doc, { command: "replace", content: "x", in: "deadbeef" })).toMatchObject({
      ok: false,
      error: { code: "not_found", message: 'Block hash "deadbeef" was not found' },
    });
    expect(
      resolve(doc, {
        command: "replace",
        content: "x",
        in: `${model.getBlockId(second)}..${model.getBlockId(first)}`,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_write" } });
  });

  it("does not resolve stale hex-shaped write fragments through section slugs", () => {
    const doc = createDoc("# cafe\n\nScene text");

    expect(model.lookupBlock(doc, "cafe")).toMatchObject({ ok: false, reason: "not_found" });
    for (const params of [
      { command: "replace" as const, content: "Replacement", in: "#cafe" },
      { command: "replace" as const, content: "", in: "#cafe" },
      { command: "replace" as const, content: "Replacement", find: "Scene", in: "#cafe" },
    ]) {
      expect(resolve(doc, params)).toMatchObject({
        ok: false,
        error: { code: "not_found", message: 'Block hash "cafe" was not found' },
      });
    }
  });

  it("still resolves explicit non-hex section slugs for writes", () => {
    const doc = createDoc("# my scene\n\nScene text\n\n# Next\n\nOther text");
    const [heading, body] = model.getBlocks(doc);

    const edits = expectOk(
      resolve(doc, { command: "replace", content: "Replacement", in: "#my-scene" }),
    );

    expect(edits.map((edit) => edit.kind)).toEqual(["insert", "delete", "delete"]);
    expect(edits[1].kind === "delete" ? edits[1].block : null).toBe(heading);
    expect(edits[2].kind === "delete" ? edits[2].block : null).toBe(body);
  });

  it("resolves real block hashes used as mutating file fragments", () => {
    const doc = createDoc("Alpha\n\nBeta");
    const [, beta] = model.getBlocks(doc);
    const hash = model.getBlockId(beta);

    const edits = expectOk(
      resolveWrite(
        { doc, model, codec },
        {
          documentAddress: {
            documentId: "123e4567-e89b-12d3-a456-426614174000",
            filePath: "chapter.md",
            fragment: hash,
          },
          command: "replace",
          content: "Gamma",
        },
      ),
    );

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "text", block: beta, newText: "Gamma" });
  });

  it("returns an actionable ambiguous error for insert block anchors", () => {
    const doc = createDoc(collisionMarkdown());
    const fixture = prefixCollisionFixture(model, model.getBlocks(doc));

    const result = resolve(doc, {
      command: "insert",
      content: "Inserted",
      after: fixture.sharedPrefix,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ambiguous_match" } });
    if (result.ok) throw new Error("expected ambiguous insert failure");
    expect(result.error.message).toContain("ambiguous");
    expect(result.error.message).not.toContain("not found");
    for (const candidate of fixture.candidates) {
      expect(result.error.message).toContain(candidate.displayHash);
    }
  });

  it("returns an actionable ambiguous error for replace scopes", () => {
    const doc = createDoc(collisionMarkdown());
    const fixture = prefixCollisionFixture(model, model.getBlocks(doc));

    const result = resolve(doc, {
      command: "replace",
      content: "Replacement",
      in: fixture.sharedPrefix,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "ambiguous_match" } });
    if (result.ok) throw new Error("expected ambiguous replace failure");
    expect(result.error.message).toContain("ambiguous");
    expect(result.error.message).not.toContain("not found");
    for (const candidate of fixture.candidates) {
      expect(result.error.message).toContain(candidate.displayHash);
    }
  });

  it("keeps displayed collision hashes unique while shorter prefixes stay ambiguous", () => {
    const doc = createDoc(collisionMarkdown());
    const fixture = prefixCollisionFixture(model, model.getBlocks(doc));

    const scope = resolveScope({ doc, model }, fixture.sharedPrefix);
    expect(scope).toMatchObject({ ok: false, code: "ambiguous" });
    if (scope.ok) throw new Error("expected ambiguous scope");
    if (scope.code !== "ambiguous") throw new Error(`expected ambiguous scope, got ${scope.code}`);
    expect(scope.matches).toEqual(fixture.candidates.map((candidate) => candidate.block));

    const displayedInsert = expectOk(
      resolve(doc, {
        command: "insert",
        content: "Inserted after target",
        after: fixture.target.displayHash,
      }),
    )[0];
    expect(displayedInsert.kind === "insert" ? displayedInsert.after : null).toBe(
      fixture.target.block,
    );

    const displayedReplace = expectOk(
      resolve(doc, {
        command: "replace",
        content: "Replacement",
        in: fixture.target.displayHash,
      }),
    )[0];
    expect(displayedReplace.kind === "text" ? displayedReplace.block : null).toBe(
      fixture.target.block,
    );

    for (const params of [
      { command: "insert" as const, content: "Nope", after: fixture.sharedPrefix },
      { command: "replace" as const, content: "Nope", in: fixture.sharedPrefix },
    ]) {
      const result = resolve(doc, params);
      expect(result).toMatchObject({ ok: false, error: { code: "ambiguous_match" } });
      if (result.ok) throw new Error("expected ambiguous write failure");
      for (const candidate of fixture.candidates) {
        expect(result.error.message).toContain(candidate.displayHash);
      }
    }
  });
});

function createDoc(markdown: string) {
  const doc = createCollabYDoc({ gc: false });
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
  doc: ReturnType<typeof createDoc>,
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
