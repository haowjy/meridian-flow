// Certification rejection matrix for SemanticEditIRV1.

import { describe, expect, it } from "vitest";
import type { SemanticEditIRV1 } from "./semantic-edit-ir.js";
import { validateSemanticEditIRV1 } from "./semantic-edit-ir.js";

const root = { clientID: 1, clock: 10, length: 2 };
const base = (payload = "😀"): SemanticEditIRV1 => ({
  version: 1,
  documentId: "doc-1",
  inputRevision: "revision-1",
  scope: [root],
  deleted: [root],
  intent: {
    kind: "mappedEdits",
    edits: [
      {
        edit: {
          kind: "text",
          documentId: "doc-1",
          file: "chapter.md",
          block: {} as never,
          span: { start: 0, end: 2 },
          newText: payload,
        },
        outputRuns: [{ kind: "fresh", payload, output: { from: 0, to: payload.length } }],
      },
    ],
  },
});

describe("SemanticEditIRV1", () => {
  it("accepts an exhaustive fresh output and explicit total zero-continuation intent", () => {
    expect(() =>
      validateSemanticEditIRV1(base(), {
        expectedDocumentId: "doc-1",
        expectedInputRevision: "revision-1",
      }),
    ).not.toThrow();
    expect(() =>
      validateSemanticEditIRV1(
        {
          ...base(),
          intent: { kind: "fullScopeFreshReplacement", payload: "new" },
        },
        { expectedDocumentId: "doc-1", expectedInputRevision: "revision-1" },
      ),
    ).not.toThrow();
  });

  it.each([
    ["stale revision", (ir: SemanticEditIRV1) => ir, { expectedInputRevision: "revision-2" }],
    [
      "unclaimed target",
      (ir: SemanticEditIRV1) => {
        if (ir.intent.kind === "mappedEdits") ir.intent.edits[0].outputRuns = [];
        return ir;
      },
      {},
    ],
    [
      "overlap",
      (ir: SemanticEditIRV1) => {
        if (ir.intent.kind === "mappedEdits") {
          ir.intent.edits[0].outputRuns.push({
            kind: "fresh",
            payload: "😀",
            output: { from: 0, to: 2 },
          });
        }
        return ir;
      },
      {},
    ],
    [
      "payload mismatch",
      (ir: SemanticEditIRV1) => {
        if (ir.intent.kind === "mappedEdits") {
          const run = ir.intent.edits[0].outputRuns[0];
          if (run?.kind === "fresh") run.payload = "xx";
        }
        return ir;
      },
      {},
    ],
  ])("rejects %s", (_name, mutate, optionOverrides) => {
    expect(() =>
      validateSemanticEditIRV1(mutate(base()), {
        expectedDocumentId: "doc-1",
        expectedInputRevision: "revision-1",
        ...optionOverrides,
      }),
    ).toThrow();
  });

  it("rejects surrogate splitting and uncertified restorations", () => {
    const split = base();
    if (split.intent.kind === "mappedEdits") {
      split.intent.edits[0].outputRuns = [
        { kind: "fresh", payload: "\ud83d", output: { from: 0, to: 1 } },
        { kind: "fresh", payload: "\ude00", output: { from: 1, to: 2 } },
      ];
    }
    expect(() =>
      validateSemanticEditIRV1(split, {
        expectedDocumentId: "doc-1",
        expectedInputRevision: "revision-1",
      }),
    ).toThrow(/surrogate/);

    const restoration = base("ok");
    if (restoration.intent.kind === "mappedEdits") {
      restoration.intent.edits[0].outputRuns = [
        { kind: "restoration", root, payload: "ok", output: { from: 0, to: 2 } },
      ];
    }
    expect(() =>
      validateSemanticEditIRV1(restoration, {
        expectedDocumentId: "doc-1",
        expectedInputRevision: "revision-1",
      }),
    ).toThrow(/certificate/);
  });
});
