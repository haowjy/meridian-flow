/**
 * Tests resolve behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Mapped-edit lowering, selector scope, and receipt segmentation
 */

import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { Doc, type XmlElement } from "yjs";
import { editSegments } from "../apply/segments.js";
import { inlineReplacementText, type ResolvedEdit } from "../apply/types.js";
import { type AgentEditCodec, createAgentEditCodecFactory } from "../codec-adapter.js";
import type { BlockRef, DocHandle } from "../handles.js";
import {
  blockHashesForDoc,
  fullHashForItemId,
  getBlockItemId,
  getTopLevelXmlBlocks,
  lookupBlockHash,
} from "../model/block-hash.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import type { AgentEditModel } from "../ports/model.js";
import { alignBlocks, type CanPair } from "./block-alignment.js";
import { findTextMatches } from "./find.js";
import { type ResolveWriteParams, type ResolveWriteResult, resolveWrite } from "./resolve.js";
import { type BlockScope, resolveScope } from "./scope.js";
import { collisionMarkdown, prefixCollisionFixture } from "./test-support/hash-collision.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
const model = yProsemirrorModel(schema);

describe("resolveWrite", () => {
  it("keeps unchanged punctuation identity even when replacing every block", () => {
    const doc = createDoc("Alpha.\n\nBeta.");
    const intent = (content: string) => {
      const result = resolve(doc, { command: "replace", content, in: [1, 2] });
      return result.ok ? result.ir.intent.kind : result.error.code;
    };

    expect(intent("Gamma.\n\nDelta.")).toBe("mappedEdits");
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
    expect(edits[0]).toMatchObject({ kind: "textRanges", block: omega });
    expect(edits[0].kind === "textRanges" ? edits[0].output : null).toBe("!");
  });

  it("decomposes a block range replace across block/delete/insert primitives", () => {
    const doc = createDoc("Alpha\n\nBeta\n\nGamma");
    const [alpha, beta, gamma] = model.getBlocks(doc);
    const range = `${model.getBlockId(alpha)}..${model.getBlockId(gamma)}`;

    const fewer = expectOk(resolve(doc, { command: "replace", content: "One", in: range }));
    expect(fewer.map((edit) => edit.kind)).toEqual(["textRanges", "delete", "delete"]);
    expect(fewer[0].kind === "textRanges" ? fewer[0].block : null).toBe(alpha);
    expect(fewer[1].kind === "delete" ? fewer[1].block : null).toBe(beta);

    const more = expectOk(
      resolve(createDoc("Alpha\n\nBeta"), {
        command: "replace",
        content: "One\n\nTwo\n\nThree",
        in: rangeFor("Alpha\n\nBeta"),
      }),
    );
    expect(more.map((edit) => edit.kind)).toEqual(["textRanges", "textRanges", "insert"]);
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
        { doc, model, codec, links: "preassigned" },
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
    expect(displayedReplace.kind === "textRanges" ? displayedReplace.block : null).toBe(
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
    { doc, model, codec, links: "preassigned" },
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

it("groups the same exact word splices by edit, sentence or paragraph", () => {
  const doc = createDoc("She did what she wanted. She left.");
  const edits = expectOk(
    resolve(doc, { command: "replace", content: "I do what I wanted. I left.", in: 1 }),
  );
  expect(edits[0].kind).toBe("textRanges");
  expect(editSegments(doc, model, edits, "edit")).toHaveLength(4);
  expect(editSegments(doc, model, edits, "sentence")).toHaveLength(2);
  expect(editSegments(doc, model, edits, "paragraph")).toHaveLength(1);
});

it("falls back to one block segment for changed marks and hard breaks", () => {
  for (const [before, after] of [
    ["She carries a sword.", "She carries a **sword**."],
    ["She carries a sword.  \nShe leaves.", "I carry a sword.  \nI leave."],
  ]) {
    const doc = createDoc(before);
    const edits = expectOk(resolve(doc, { command: "replace", content: after, in: 1 }));
    expect(edits).toHaveLength(1);
    expect(edits[0].kind).toBe("block");
    expect(editSegments(doc, model, edits)).toHaveLength(1);
  }
});

{
  const schema = buildDocumentSchema();
  const codec = mdxCodec({ schema });

  describe("lookupBlockHash", () => {
    it("resolves a longer-than-current-display prefix", () => {
      const doc = createHashDoc("Alpha\n\nBeta\n\nGamma");
      const blocks = getTopLevelXmlBlocks(doc);
      const displayedHash = blockHashesForDoc(doc)[1];
      const longerPrefix = fullHash(blocks[1]).slice(0, displayedHash.length + 3);

      const lookup = lookupBlockHash(doc, longerPrefix);

      expect(lookup).toMatchObject({ ok: true, hash: longerPrefix });
      expect(lookup.ok && lookup.block).toBe(blocks[1]);
    });
  });

  function createHashDoc(markdown: string): Doc {
    const doc = new Doc({ gc: false });
    doc.clientID = 1;
    const parsed = codec.parse(markdown);
    const root = schema.node("doc", null, parsed.blocks);
    prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
    return doc;
  }

  function fullHash(block: XmlElement): string {
    return fullHashForItemId(getBlockItemId(block));
  }
}

{
  const schema = buildDocumentSchema();
  it.each([
    ["青山绿水长河天地", ["青山", "绿水", "长河天地"]],
    ["one two one three four five six", ["one two", "one", "three four five six"]],
  ] as const)("joins three-way split/merge with either head or tail paired: %s", (text, parts) => {
    const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
    const whole = [paragraph(text)],
      pieces = parts.map(paragraph);
    for (const paired of [0, pieces.length - 1]) {
      const split: CanPair = (_old, next) => next === pieces[paired];
      const merge: CanPair = (old, _next) => old === pieces[paired];
      for (const [before, after, canPair] of [
        [whole, pieces, split],
        [pieces, whole, merge],
      ] as const) {
        const steps = alignBlocks(before, after, canPair);
        expect(steps).toHaveLength(3);
        expect(steps[0].structuralBoundary).toBeDefined();
        expect(new Set(steps.map((step) => step.structuralBoundary)).size).toBe(1);
      }
    }
  });
}

{
  describe("findTextMatches", () => {
    it("keeps an empty block in the middle of an exact multi-block needle", () => {
      const result = findInBodies(["A", "", "B"], "A\n\n\n\nB");

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(result.message);
      expect(result.matches[0]).toMatchObject({
        startIndex: 0,
        endIndex: 2,
        rangeSource: "A\n\n\n\nB",
        matchEnd: "A\n\n\n\nB".length,
      });
    });

    it("does not reinterpret mixed prose and hash-shaped lines", () => {
      const result = findInBodies(["tail"], "Plain text\nde0e|tail");

      expect(result).toMatchObject({
        ok: false,
        code: "not_found",
        message: 'Could not find "Plain text\nde0e|tail" in the selected scope',
      });
    });

    it("keeps hash-shaped raw document content literal when literal matching succeeds", () => {
      const result = findInBodies(["abcd|note"], "abcd|note");

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw new Error(result.message);
      expect(result.matches[0]).toMatchObject({
        rangeSource: "abcd|note",
        matchEnd: "abcd|note".length,
      });
    });
  });

  function findInBodies(bodies: string[], find: string, all = false) {
    const blocks = bodies.map((_, index) => ({ index }) as unknown as BlockRef);
    const ctx = {
      doc: {} as DocHandle,
      codec: {} as AgentEditCodec,
      model: {
        getBlocks: () => blocks,
        serializeBlockBodies: (_doc, _codec, selected) =>
          selected.map((block) => bodies[blocks.indexOf(block)] ?? ""),
      } satisfies Partial<AgentEditModel> as unknown as AgentEditModel,
    };
    const scope: BlockScope = {
      kind: "document",
      blocks,
      startIndex: 0,
      endIndex: blocks.length - 1,
    };
    return findTextMatches(ctx, scope, find, all);
  }
}
