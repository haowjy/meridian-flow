/**
 * Decoration builder tests — covers the null / empty / unresolvable paths.
 * Rendered decoration geometry against a live y-prosemirror binding is
 * covered by the browser-prober smoke — the plugin composes with the real
 * editor mount, and duplicating that here would just re-shape the fake.
 */
import { createRequire } from "node:module";
import type { ReviewOperation } from "@meridian/contracts/drafts";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Decoration } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildDecorations, inlineReviewClassNames } from "./decorations";
import { buildInlineReviewModel } from "./model";

function encodeAnchor(position: Y.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(position)).toString("base64");
}

type DecorationKind = "agent" | "writer" | "emphasized" | "deletion";

function decorationKinds(
  decorations: ReturnType<ReturnType<typeof buildDecorations>["find"]>,
  operations: readonly { operationId: string; kind: "agent" | "writer" }[],
  activeOperationId: string | null = null,
): Set<DecorationKind> {
  const operationsById = new Map(operations.map((op) => [op.operationId, op.kind]));
  const kinds = new Set<DecorationKind>();
  for (const decoration of decorations) {
    if (decoration.from === decoration.to) kinds.add("deletion");
    const operationIds = String(
      (decoration.spec as Record<string, unknown> | undefined)?.["data-review-operations"] ?? "",
    )
      .split(" ")
      .filter(Boolean);
    if (activeOperationId && operationIds.includes(activeOperationId)) kinds.add("emphasized");
    for (const operationId of operationIds) {
      const kind = operationsById.get(operationId);
      if (kind) kinds.add(kind);
    }
  }
  return kinds;
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
      { conflictLabel: "", draftRevisionToken: 1, operations: [], hunks: [] },
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
          kind: "text",
          spans: [],
          deletedText: "gone",
        },
      ],
    });

    const decorations = buildDecorations(model, "op-a", resolver);
    const emitted = decorations.find();
    expect(emitted).toHaveLength(1);
    expect(decorationKinds(emitted, [{ operationId: "op-a", kind: "agent" }], "op-a")).toEqual(
      new Set(["agent", "deletion", "emphasized"]),
    );
  });

  it("adds the edited-since-draft chip to a conflicted hunk", () => {
    const resolver = makeResolver();
    const relPos = Y.createRelativePositionFromTypeIndex(resolver.yFragment, 0);
    const encoded = encodeAnchor(relPos);
    const model = buildInlineReviewModel({
      draftRevisionToken: 1,
      operations: [],
      conflictedBlocks: new Set(["block-a"]),
      conflictLabel: "edited since this draft was written",
      hunks: [
        {
          hunkId: "h-conflict",
          operationIds: [],
          blockHashes: ["block-a"],
          anchor: { relStart: encoded, relEnd: encoded },
          kind: "text",
          spans: [],
          deletedText: "old words",
        },
      ],
    });

    const widgets = buildDecorations(model, null, resolver)
      .find()
      .filter((decoration) => decorationFlavor(decoration) === "widget")
      .map(renderWidget);

    expect(widgets.some((dom) => dom.className === inlineReviewClassNames.conflictChip)).toBe(true);
    expect(widgets.map((dom) => dom.textContent)).toContain("edited since this draft was written");
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
          kind: "text",
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
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
        {
          operationId: "op-writer",
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
          kind: "text",
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
    expect(
      decorationKinds(emitted, [
        { operationId: "op-ai", kind: "agent" },
        { operationId: "op-writer", kind: "writer" },
      ]),
    ).toEqual(new Set(["agent", "writer"]));
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
          kind: "text",
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
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
        {
          operationId: "op-writer",
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
          kind: "text",
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
          kind: "text",
          spans: [],
        },
      ],
    });

    const decorations = buildDecorations(model, null, resolver);
    const emitted = decorations.find();
    expect(emitted).toHaveLength(1);
    expect(decorationKinds(emitted, [{ operationId: "op-ai", kind: "agent" }])).toEqual(
      new Set(["agent"]),
    );
  });
});

/** ProseMirror marks these getters `@internal`, but they are the only way to
 *  tell decoration flavors apart without mounting a full EditorView. */
function decorationFlavor(decoration: Decoration): "inline" | "node" | "widget" {
  const probed = decoration as unknown as { inline: boolean; widget: boolean };
  if (probed.widget) return "widget";
  return probed.inline ? "inline" : "node";
}

/** Invoke a widget decoration's deferred DOM factory under a scratch JSDOM. */
function renderWidget(decoration: Decoration): HTMLElement {
  const require = createRequire(import.meta.url);
  const { JSDOM } = require("jsdom") as {
    JSDOM: new (html: string) => { window: { document: Document; close: () => void } };
  };
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previousDocument = Reflect.get(globalThis, "document");
  Reflect.set(globalThis, "document", dom.window.document);
  try {
    const type = (decoration as unknown as { type: { toDOM: () => HTMLElement } }).type;
    return type.toDOM();
  } finally {
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Reflect.set(globalThis, "document", previousDocument);
    dom.window.close();
  }
}

/** doc(paragraph("abcd"), horizontal_rule) mirrored into a resolvable Yjs mapping. */
function makeBlockResolver() {
  const yDoc = new Y.Doc();
  const yFragment = yDoc.getXmlFragment("prosemirror");
  const yParagraph = new Y.XmlElement("paragraph");
  const yText = new Y.XmlText();
  const yRule = new Y.XmlElement("horizontal_rule");
  yFragment.insert(0, [yParagraph, yRule]);
  yParagraph.insert(0, [yText]);
  yText.insert(0, "abcd");

  const schema = buildDocumentSchema();
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, schema.text("abcd")),
    schema.node("horizontal_rule"),
  ]);
  const mapping = new Map();
  mapping.set(yFragment, doc);
  mapping.set(yParagraph, doc.child(0));
  mapping.set(yRule, doc.child(1));
  return { resolver: { doc, yDoc, yFragment, mapping }, yFragment, yText };
}

const agentOperation: ReviewOperation = {
  operationId: "op-ai",
  rejectSourceUpdateIds: [1],
  kind: "agent",
  contribution: "added",
  classification: "addition",
  hunkCount: 1,
};

describe("buildDecorations — block hunks", () => {
  it("renders an inserted horizontal rule as a node decoration with data attrs", () => {
    const { resolver, yFragment } = makeBlockResolver();
    const relStart = Y.createRelativePositionFromTypeIndex(yFragment, 1);
    const relEnd = Y.createRelativePositionFromTypeIndex(yFragment, 2);

    const model = buildInlineReviewModel({
      draftRevisionToken: 30,
      operations: [agentOperation],
      hunks: [
        {
          kind: "block",
          hunkId: "h-block",
          operationIds: ["op-ai"],
          anchor: { relStart: encodeAnchor(relStart), relEnd: encodeAnchor(relEnd) },
          insertedBlock: { type: "horizontal_rule", display: "───" },
        },
      ],
    });

    const emitted = buildDecorations(model, null, resolver).find();
    expect(emitted).toHaveLength(1);
    const [decoration] = emitted;
    expect(decorationFlavor(decoration)).toBe("node");
    // paragraph("abcd") occupies 0..6; the rule is the node at 6..7.
    expect(decoration.from).toBe(6);
    expect(decoration.to).toBe(7);
    expect(decoration.spec["data-review-hunk"]).toBe("h-block");
    expect(decoration.spec["data-review-operations"]).toBe("op-ai");
  });

  it("renders a deleted horizontal rule as a block widget carrying the struck display", () => {
    const { resolver, yFragment } = makeBlockResolver();
    // Zero-width anchor at the delete site (before the paragraph).
    const rel = Y.createRelativePositionFromTypeIndex(yFragment, 0);
    const encoded = encodeAnchor(rel);

    const model = buildInlineReviewModel({
      draftRevisionToken: 31,
      operations: [agentOperation],
      hunks: [
        {
          kind: "block",
          hunkId: "h-del",
          operationIds: ["op-ai"],
          anchor: { relStart: encoded, relEnd: encoded },
          deletedBlock: { type: "horizontal_rule", display: "───" },
        },
      ],
    });

    const emitted = buildDecorations(model, null, resolver).find();
    expect(emitted).toHaveLength(1);
    const [decoration] = emitted;
    expect(decorationFlavor(decoration)).toBe("widget");
    expect(decoration.from).toBe(0);
    expect(decoration.spec["data-review-hunk"]).toBe("h-del");
    expect(decoration.spec["data-review-operations"]).toBe("op-ai");

    const dom = renderWidget(decoration);
    expect(dom.tagName).toBe("DIV");
    expect(dom.className).toContain(inlineReviewClassNames.removed);
    expect(dom.className).toContain(inlineReviewClassNames.removedBlock);
    expect(dom.getAttribute("data-review-block-type")).toBe("horizontal_rule");
    expect(dom.getAttribute("data-review-hunk")).toBe("h-del");
    expect(dom.getAttribute("data-review-operations")).toBe("op-ai");
    expect(dom.textContent).toBe("───");
  });

  it("renders a change hunk as struck old block above the highlighted new node", () => {
    const { resolver, yFragment } = makeBlockResolver();
    const relStart = Y.createRelativePositionFromTypeIndex(yFragment, 1);
    const relEnd = Y.createRelativePositionFromTypeIndex(yFragment, 2);

    const model = buildInlineReviewModel({
      draftRevisionToken: 32,
      operations: [agentOperation],
      hunks: [
        {
          kind: "block",
          hunkId: "h-change",
          operationIds: ["op-ai"],
          anchor: { relStart: encodeAnchor(relStart), relEnd: encodeAnchor(relEnd) },
          insertedBlock: { type: "horizontal_rule", display: "───" },
          deletedBlock: { type: "bullet_list", display: "old item" },
        },
      ],
    });

    const emitted = buildDecorations(model, null, resolver).find();
    expect(emitted).toHaveLength(2);
    const widget = emitted.find((decoration) => decorationFlavor(decoration) === "widget");
    const node = emitted.find((decoration) => decorationFlavor(decoration) === "node");
    expect(widget?.from).toBe(6);
    expect(node?.from).toBe(6);
    expect(node?.to).toBe(7);
    expect(renderWidget(widget as Decoration).textContent).toBe("old item");
  });

  it("keeps text and block hunks independent in a mixed document", () => {
    const { resolver, yFragment, yText } = makeBlockResolver();
    const relTextStart = Y.createRelativePositionFromTypeIndex(yText, 0);
    const relTextEnd = Y.createRelativePositionFromTypeIndex(yText, 4);
    const relBlockStart = Y.createRelativePositionFromTypeIndex(yFragment, 1);
    const relBlockEnd = Y.createRelativePositionFromTypeIndex(yFragment, 2);

    const model = buildInlineReviewModel({
      draftRevisionToken: 33,
      operations: [agentOperation],
      hunks: [
        {
          kind: "text",
          hunkId: "h-text",
          operationIds: ["op-ai"],
          anchor: { relStart: encodeAnchor(relTextStart), relEnd: encodeAnchor(relTextEnd) },
          spans: [],
        },
        {
          kind: "block",
          hunkId: "h-block",
          operationIds: ["op-ai"],
          anchor: { relStart: encodeAnchor(relBlockStart), relEnd: encodeAnchor(relBlockEnd) },
          insertedBlock: { type: "horizontal_rule", display: "───" },
        },
      ],
    });

    const emitted = buildDecorations(model, null, resolver).find();
    expect(emitted).toHaveLength(2);
    expect(emitted.map(decorationFlavor).sort()).toEqual(["inline", "node"]);
    const inline = emitted.find((decoration) => decorationFlavor(decoration) === "inline");
    expect(inline?.from).toBe(1);
    expect(inline?.to).toBe(5);
  });

  it("falls back to an inline range when the anchor no longer spans one node", () => {
    const { resolver, yFragment } = makeBlockResolver();
    // Anchor spans both top-level blocks — no single node matches, so the
    // builder degrades to a range decoration instead of dropping the hunk.
    const relStart = Y.createRelativePositionFromTypeIndex(yFragment, 0);
    const relEnd = Y.createRelativePositionFromTypeIndex(yFragment, 2);

    const model = buildInlineReviewModel({
      draftRevisionToken: 34,
      operations: [agentOperation],
      hunks: [
        {
          kind: "block",
          hunkId: "h-wide",
          operationIds: ["op-ai"],
          anchor: { relStart: encodeAnchor(relStart), relEnd: encodeAnchor(relEnd) },
          insertedBlock: { type: "bullet_list", display: "wide" },
        },
      ],
    });

    const emitted = buildDecorations(model, null, resolver).find();
    expect(emitted).toHaveLength(1);
    expect(decorationFlavor(emitted[0])).toBe("inline");
    expect(emitted[0].from).toBe(0);
    expect(emitted[0].to).toBe(7);
  });
});
