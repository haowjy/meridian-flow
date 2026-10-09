import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { inlineReplacementText, type ResolvedEdit } from "../apply/types.js";
import { createAgentEditCodecFactory } from "../codec-adapter.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { type ResolveWriteParams, type ResolveWriteResult, resolveWrite } from "./resolve.js";
import { resolveScope } from "./scope.js";
import { collisionMarkdown, prefixCollisionFixture } from "./test-support/hash-collision.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).bind(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(schema);

describe("resolveWrite", () => {
  it("records a whole-scope replace as fresh only when it rewrote every block", () => {
    const doc = createDoc("Alpha.\n\nBeta.");
    const intent = (content: string) => {
      const result = resolve(doc, { command: "replace", content, in: [1, 2] });
      return result.ok ? result.ir.intent.kind : result.error.code;
    };

    expect(intent("Gamma.\n\nDelta.")).toBe("fullScopeFreshReplacement");
    expect(intent("Alpha.\n\nDelta.")).toBe("mappedEdits");
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

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "block", block: omega });
    expect(edits[0].kind === "block" ? edits[0].replacement.textContent : null).toBe("ends Omega!");
  });

  it("decomposes a block range replace across block/delete/insert primitives", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const [alpha, beta, gamma] = model.getBlocks(doc);
    const range = `${model.getBlockId(alpha)}..${model.getBlockId(gamma)}`;

    const fewer = expectOk(resolve(doc, { command: "replace", content: "One", in: range }));
    expect(fewer.map((edit) => edit.kind)).toEqual(["block", "delete", "delete"]);
    expect(fewer[0].kind === "block" ? fewer[0].block : null).toBe(alpha);
    expect(fewer[1].kind === "delete" ? fewer[1].block : null).toBe(beta);

    const more = expectOk(
      resolve(createDoc("Alpha\n\nBeta"), {
        command: "replace",
        content: "One\n\nTwo\n\nThree",
        in: rangeFor("Alpha\n\nBeta"),
      }),
    );
    expect(more.map((edit) => edit.kind)).toEqual(["block", "block", "insert"]);
  });

  it("matches find text with NFC normalization while preserving original spans", () => {
    const doc = createDoc("cafe\u0301 sword");

    const edits = expectOk(resolve(doc, { command: "replace", content: "tea", find: "café" }));

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      kind: "textRanges",
      replacements: [{ span: { start: 0, end: 5 } }],
      output: "tea",
    });
    const [edit] = edits;
    if (edit?.kind !== "textRanges") throw new Error("expected textRanges");
    expect(edit.replacements.map(inlineReplacementText)).toEqual(["tea"]);
  });

  it("scopes find-based writes to the around window", () => {
    const doc = createDoc(aroundNeedleDoc());
    const blocks = model.getBlocks(doc);
    const around = model.getBlockId(blocks[4]);

    const replace = expectOk(
      resolve(doc, { command: "replace", content: "changed", find: "needle", around }),
    );

    expect(replace).toHaveLength(1);
    expect(replace[0]).toMatchObject({ kind: "textRanges", block: blocks[4] });
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
      error: {
        code: "not_found",
        message: expect.stringContaining(
          'Block hash "deadbeef" was not found in the version your writes change',
        ),
      },
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
      { command: "remove" as const, in: "#cafe" },
      { command: "replace" as const, content: "Replacement", find: "Scene", in: "#cafe" },
    ]) {
      expect(resolve(doc, params)).toMatchObject({
        ok: false,
        error: {
          code: "not_found",
          message: expect.stringContaining(
            'Block hash "cafe" was not found in the version your writes change',
          ),
        },
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

  it("removes the blocks selected by `in` or a path fragment", () => {
    const doc = createDoc("Alpha\n\nBeta");
    const [, beta] = model.getBlocks(doc);
    const hash = model.getBlockId(beta);
    const address = (fragment?: string) => ({
      documentId: "123e4567-e89b-12d3-a456-426614174000",
      filePath: "chapter.md",
      ...(fragment === undefined ? {} : { fragment }),
    });
    const remove = (fragment: string | undefined, scope: string | undefined) =>
      resolveWrite(
        { doc, model, codec },
        {
          documentAddress: address(fragment),
          command: "remove",
          ...(scope === undefined ? {} : { in: scope }),
        },
      );

    for (const removed of [remove(hash, undefined), remove(undefined, hash)]) {
      expect(expectOk(removed).map((edit) => edit.kind)).toEqual(["delete"]);
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
    expect(displayedReplace.kind === "block" ? displayedReplace.block : null).toBe(
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
