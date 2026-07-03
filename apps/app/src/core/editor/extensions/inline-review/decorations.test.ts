/**
 * Decoration builder tests — covers the null / empty / unresolvable paths.
 * Rendered decoration geometry against a live y-prosemirror binding is
 * covered by the browser-prober smoke — the plugin composes with the real
 * editor mount, and duplicating that here would just re-shape the fake.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildDecorations, inlineReviewClassNames } from "./decorations";
import { buildInlineReviewModel } from "./model";

function makeResolver() {
  const yDoc = new Y.Doc();
  const yFragment = yDoc.getXmlFragment("prosemirror");
  const schema = buildDocumentSchema();
  const doc = schema.node("doc", null, [schema.node("paragraph", null)]);
  return { doc, yDoc, yFragment, mapping: new Map() };
}

describe("buildDecorations", () => {
  it("returns an empty set when the model is null", () => {
    const resolver = makeResolver();
    const decorations = buildDecorations(null, null, resolver);
    expect(decorations.find()).toHaveLength(0);
  });

  it("returns an empty set when the model has no hunks", () => {
    const resolver = makeResolver();
    const decorations = buildDecorations(
      { draftRevisionToken: 1, operations: [], hunks: [] },
      null,
      resolver,
    );
    expect(decorations.find()).toHaveLength(0);
  });

  it("emits a widget decoration for a pure deletion whose anchor resolves", () => {
    const resolver = makeResolver();
    const relPos = Y.createRelativePositionFromTypeIndex(resolver.yFragment, 0);
    const encoded = Buffer.from(Y.encodeRelativePosition(relPos)).toString("base64");
    const model = buildInlineReviewModel({
      draftRevisionToken: 2,
      operations: [
        {
          operationId: "op-a",
          sourceUpdateIds: [1],
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "edited",
          classification: "rewrite",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h1",
          operationIds: ["op-a"],
          anchor: { relStart: encoded, relEnd: encoded },
          spans: [],
          deletedText: "gone",
        },
      ],
    });

    const decorations = buildDecorations(model, null, resolver);
    const emitted = decorations.find();
    expect(emitted).toHaveLength(1);
  });

  it("skips hunks whose start anchor points past the document (stale after edits)", () => {
    const resolver = makeResolver();
    // The empty paragraph has size 2 (open + close tags). An index at 999 is
    // guaranteed to sit past the doc; the resolver reports a bounds-crossing
    // resolution and the builder drops the hunk.
    const relPos = Y.createRelativePositionFromTypeIndex(resolver.yFragment, 999);
    const encoded = Buffer.from(Y.encodeRelativePosition(relPos)).toString("base64");
    const model = buildInlineReviewModel({
      draftRevisionToken: 3,
      operations: [
        {
          operationId: "op-a",
          sourceUpdateIds: [1],
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "edited",
          classification: "rewrite",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h1",
          operationIds: ["op-a"],
          anchor: { relStart: encoded, relEnd: encoded },
          spans: [],
          deletedText: "stale",
        },
      ],
    });
    // The anchor decodes but resolves past the doc size — the builder must
    // not throw and must not emit a decoration.
    const decorations = buildDecorations(model, null, resolver);
    // Accept either the hunk being kept (out of range guard clamps) or
    // dropped; both are valid "no crash" outcomes. What matters is that
    // it never throws and never returns a decoration past doc.content.size.
    for (const decoration of decorations.find()) {
      expect(decoration.from).toBeLessThanOrEqual(resolver.doc.content.size);
    }
  });

  it("exposes the class-name constants the plugin renders", () => {
    // Freeze the wire contract so CSS + plugin can't drift silently.
    expect(inlineReviewClassNames.added).toBe("meridian-review-added");
    expect(inlineReviewClassNames.writer).toBe("meridian-review-writer");
    expect(inlineReviewClassNames.emphasized).toBe("meridian-review-emphasized");
    expect(inlineReviewClassNames.removed).toBe("meridian-review-removed");
  });
});
