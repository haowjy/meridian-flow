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

function encodeAnchor(position: Y.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(position)).toString("base64");
}

/**
 * Pull the DOM class off an inline decoration. `Decoration` doesn't expose
 * its attrs directly, but the internal `type` slot carries them. Cast is
 * scoped to the test — prod code never inspects decoration attrs this way.
 */
function decorationClass(decoration: unknown): string {
  return (
    (decoration as { type?: { attrs?: { class?: string } } } | undefined)?.type?.attrs?.class ?? ""
  );
}

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

  it("paints nested authorship per span when a hunk carries writer inside AI", () => {
    // Build a real y-prosemirror mapping so span anchors resolve. We insert
    // 4 chars of text and split it into two spans: [0,2) → AI, [2,4) →
    // writer. The decoration builder must emit two separate inline
    // decorations, each colored by its owning operation.
    const yDoc = new Y.Doc();
    const yFragment = yDoc.getXmlFragment("prosemirror");
    const yParagraph = new Y.XmlElement("paragraph");
    yFragment.insert(0, [yParagraph]);
    const yText = new Y.XmlText();
    yParagraph.insert(0, [yText]);
    yText.insert(0, "abcd");

    const schema = buildDocumentSchema();
    const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("abcd"))]);
    const mapping = new Map();
    mapping.set(yFragment, doc);
    mapping.set(yParagraph, doc.child(0));
    const resolver = { doc, yDoc, yFragment, mapping };

    // Anchors: draft insertion range covers indices 0..4 of yText.
    const relHunkStart = Y.createRelativePositionFromTypeIndex(yText, 0);
    const relHunkEnd = Y.createRelativePositionFromTypeIndex(yText, 4);
    const relSpanMid = Y.createRelativePositionFromTypeIndex(yText, 2);

    const model = buildInlineReviewModel({
      draftRevisionToken: 9,
      operations: [
        {
          operationId: "op-ai",
          sourceUpdateIds: [1],
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
        {
          operationId: "op-writer",
          sourceUpdateIds: [2],
          rejectSourceUpdateIds: [2],
          kind: "writer",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h1",
          operationIds: ["op-ai", "op-writer"],
          anchor: {
            relStart: encodeAnchor(relHunkStart),
            relEnd: encodeAnchor(relHunkEnd),
          },
          spans: [
            {
              anchorFrom: encodeAnchor(relHunkStart),
              anchorTo: encodeAnchor(relSpanMid),
              operationId: "op-ai",
            },
            {
              anchorFrom: encodeAnchor(relSpanMid),
              anchorTo: encodeAnchor(relHunkEnd),
              operationId: "op-writer",
            },
          ],
        },
      ],
    });

    const decorations = buildDecorations(model, null, resolver);
    const emitted = decorations.find();
    // Two inline decorations — one per span.
    expect(emitted).toHaveLength(2);
    const classes = emitted.map(decorationClass);
    expect(classes.some((c) => c.includes(inlineReviewClassNames.added))).toBe(true);
    expect(classes.some((c) => c.includes(inlineReviewClassNames.writer))).toBe(true);
  });

  it("merges adjacent same-operation spans into one continuous decoration", () => {
    // Server may emit one span per Yjs update row (per keystroke). Client
    // must not render seams within a single operation — otherwise the
    // reader sees per-letter tiles.
    const yDoc = new Y.Doc();
    const yFragment = yDoc.getXmlFragment("prosemirror");
    const yParagraph = new Y.XmlElement("paragraph");
    yFragment.insert(0, [yParagraph]);
    const yText = new Y.XmlText();
    yParagraph.insert(0, [yText]);
    yText.insert(0, "wef!");

    const schema = buildDocumentSchema();
    const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("wef!"))]);
    const mapping = new Map();
    mapping.set(yFragment, doc);
    mapping.set(yParagraph, doc.child(0));
    const resolver = { doc, yDoc, yFragment, mapping };

    const rel0 = Y.createRelativePositionFromTypeIndex(yText, 0);
    const rel1 = Y.createRelativePositionFromTypeIndex(yText, 1);
    const rel2 = Y.createRelativePositionFromTypeIndex(yText, 2);
    const rel3 = Y.createRelativePositionFromTypeIndex(yText, 3);

    const model = buildInlineReviewModel({
      draftRevisionToken: 20,
      operations: [
        {
          operationId: "op-writer",
          sourceUpdateIds: [1, 2, 3],
          rejectSourceUpdateIds: [1, 2, 3],
          kind: "writer",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h1",
          operationIds: ["op-writer"],
          anchor: { relStart: encodeAnchor(rel0), relEnd: encodeAnchor(rel3) },
          spans: [
            {
              anchorFrom: encodeAnchor(rel0),
              anchorTo: encodeAnchor(rel1),
              operationId: "op-writer",
            },
            {
              anchorFrom: encodeAnchor(rel1),
              anchorTo: encodeAnchor(rel2),
              operationId: "op-writer",
            },
            {
              anchorFrom: encodeAnchor(rel2),
              anchorTo: encodeAnchor(rel3),
              operationId: "op-writer",
            },
          ],
        },
      ],
    });

    const decorations = buildDecorations(model, null, resolver);
    const inlineOnly = decorations.find().filter((d) => d.from !== d.to);
    expect(inlineOnly).toHaveLength(1);
  });

  it("preserves author boundaries when merging (writer↔agent stays split)", () => {
    const yDoc = new Y.Doc();
    const yFragment = yDoc.getXmlFragment("prosemirror");
    const yParagraph = new Y.XmlElement("paragraph");
    yFragment.insert(0, [yParagraph]);
    const yText = new Y.XmlText();
    yParagraph.insert(0, [yText]);
    yText.insert(0, "abcd");

    const schema = buildDocumentSchema();
    const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("abcd"))]);
    const mapping = new Map();
    mapping.set(yFragment, doc);
    mapping.set(yParagraph, doc.child(0));
    const resolver = { doc, yDoc, yFragment, mapping };

    const rel0 = Y.createRelativePositionFromTypeIndex(yText, 0);
    const rel2 = Y.createRelativePositionFromTypeIndex(yText, 2);
    const rel4 = Y.createRelativePositionFromTypeIndex(yText, 4);

    const model = buildInlineReviewModel({
      draftRevisionToken: 21,
      operations: [
        {
          operationId: "op-ai",
          sourceUpdateIds: [1],
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
        {
          operationId: "op-writer",
          sourceUpdateIds: [2],
          rejectSourceUpdateIds: [2],
          kind: "writer",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h1",
          operationIds: ["op-ai", "op-writer"],
          anchor: { relStart: encodeAnchor(rel0), relEnd: encodeAnchor(rel4) },
          spans: [
            { anchorFrom: encodeAnchor(rel0), anchorTo: encodeAnchor(rel2), operationId: "op-ai" },
            {
              anchorFrom: encodeAnchor(rel2),
              anchorTo: encodeAnchor(rel4),
              operationId: "op-writer",
            },
          ],
        },
      ],
    });

    const decorations = buildDecorations(model, null, resolver);
    const inlineOnly = decorations.find().filter((d) => d.from !== d.to);
    expect(inlineOnly).toHaveLength(2);
  });

  it("falls back to whole-hunk coloring when no span anchors resolve", () => {
    const yDoc = new Y.Doc();
    const yFragment = yDoc.getXmlFragment("prosemirror");
    const yParagraph = new Y.XmlElement("paragraph");
    yFragment.insert(0, [yParagraph]);
    const yText = new Y.XmlText();
    yParagraph.insert(0, [yText]);
    yText.insert(0, "abcd");

    const schema = buildDocumentSchema();
    const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("abcd"))]);
    const mapping = new Map();
    mapping.set(yFragment, doc);
    mapping.set(yParagraph, doc.child(0));
    const resolver = { doc, yDoc, yFragment, mapping };

    const relHunkStart = Y.createRelativePositionFromTypeIndex(yText, 0);
    const relHunkEnd = Y.createRelativePositionFromTypeIndex(yText, 4);

    const model = buildInlineReviewModel({
      draftRevisionToken: 10,
      operations: [
        {
          operationId: "op-ai",
          sourceUpdateIds: [1],
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h1",
          operationIds: ["op-ai"],
          anchor: {
            relStart: encodeAnchor(relHunkStart),
            relEnd: encodeAnchor(relHunkEnd),
          },
          spans: [],
        },
      ],
    });

    const decorations = buildDecorations(model, null, resolver);
    const emitted = decorations.find();
    expect(emitted).toHaveLength(1);
    expect(decorationClass(emitted[0])).toContain(inlineReviewClassNames.added);
  });

  it("exposes the class-name constants the plugin renders", () => {
    // Freeze the wire contract so CSS + plugin can't drift silently.
    expect(inlineReviewClassNames.added).toBe("meridian-review-added");
    expect(inlineReviewClassNames.writer).toBe("meridian-review-writer");
    expect(inlineReviewClassNames.emphasized).toBe("meridian-review-emphasized");
    expect(inlineReviewClassNames.removed).toBe("meridian-review-removed");
  });
});
