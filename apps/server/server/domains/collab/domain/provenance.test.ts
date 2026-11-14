/** Contract tests for deterministic provenance replay and the reserved namespace.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Provenance locator and materialization algorithm
 */

import type { SemanticEditIRV1, SemanticOutputRun } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendProvenanceFacts,
  createSemanticProvenanceWriter,
  type DocumentAuthorityId,
  materializeCandidateProvenance,
  PROVENANCE_TARGETS_TYPE,
  ProvenanceMaterializationError,
} from "./provenance.js";

const _authorityId = "00000000-0000-4000-8000-000000000100" as DocumentAuthorityId;

describe("provenance materialization", () => {
  it("writes restoration facts alongside a retained output run", () => {
    // A retained pre-v2 dev snapshot cold-loads without interpreting its old facts.
    const legacy = proseDoc("cat and cat");
    legacy
      .getArray("__meridian_provenance_targets_v1")
      .push([
        { version: 1, target: textRange(legacy), root: { clientID: 999, clock: 0, length: 11 } },
      ]);
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(legacy));
    legacy.destroy();
    const source = textRange(doc);
    const retained = { ...source, clock: source.clock + 3, length: 5 };
    const restoredRoot = { ...source, clock: source.clock + 8, length: 3 };
    const before = Y.encodeStateVector(doc);
    const text = proseText(doc);
    text.delete(8, 3);
    text.insert(8, "cat");
    text.delete(0, 3);
    text.insert(0, "kit");

    createSemanticProvenanceWriter().writeCertifiedFacts(
      doc as never,
      mappedTextIr(proseBlock(doc), source, [
        { kind: "fresh", payload: "kit", output: { from: 0, to: 3 } },
        {
          kind: "preserved",
          source: retained,
          output: { from: 3, to: 8 },
          materialization: "retained",
        },
        { kind: "restoration", root: restoredRoot, payload: "cat", output: { from: 8, to: 11 } },
      ]),
      before,
    );

    const visible = materializeCandidateProvenance(doc, [
      { target: source, root: source, birthClass: "writer_protected" },
    ]);
    const [fresh, retainedRun, restored] = visible;
    expect(visible).toHaveLength(3);
    expect(fresh).toEqual({
      target: fresh?.target,
      root: fresh?.target,
      birthClass: "agent",
    });
    expect(retainedRun).toEqual({
      target: retained,
      root: retained,
      birthClass: "writer_protected",
    });
    expect(restored).toMatchObject({
      root: restoredRoot,
      birthClass: "writer_protected",
    });
  });

  it("materializes facts in output order when semantic runs are declared out of order", () => {
    const doc = proseDoc("cat");
    const source = textRange(doc);
    const before = Y.encodeStateVector(doc);
    const text = proseText(doc);
    text.delete(0, 3);
    text.insert(0, "catkit");

    createSemanticProvenanceWriter().writeCertifiedFacts(
      doc as never,
      mappedTextIr(proseBlock(doc), source, [
        { kind: "fresh", payload: "kit", output: { from: 3, to: 6 } },
        { kind: "restoration", root: source, payload: "cat", output: { from: 0, to: 3 } },
      ]),
      before,
    );

    const [restored, fresh] = materializeCandidateProvenance(doc, [
      { target: source, root: source, birthClass: "writer_protected" },
    ]);
    expect(restored).toMatchObject({
      root: source,
      birthClass: "writer_protected",
    });
    expect(fresh).toEqual({
      target: fresh?.target,
      root: fresh?.target,
      birthClass: "agent",
    });
  });

  it("rejects restoration output wider than its certified root at the writer boundary", () => {
    const doc = proseDoc("a");
    const source = textRange(doc);
    const before = Y.encodeStateVector(doc);
    const text = proseText(doc);
    text.delete(0, 1);
    text.insert(0, "XY");

    expect(() =>
      createSemanticProvenanceWriter().writeCertifiedFacts(
        doc as never,
        mappedTextIr(proseBlock(doc), source, [
          { kind: "restoration", root: source, payload: "XY", output: { from: 0, to: 2 } },
        ]),
        before,
      ),
    ).toThrow(/length-for-length/);
  });

  it("locates a certified structural carry from its replaced input block", () => {
    const doc = proseDoc("old");
    const block = proseBlock(doc);
    const source = textRange(doc);
    const before = Y.encodeStateVector(doc);
    const fragment = doc.getXmlFragment("prosemirror");
    fragment.delete(0, 1);
    const replacementBlock = new Y.XmlElement("code_block");
    replacementBlock.push([new Y.XmlText("old")]);
    fragment.push([replacementBlock]);

    createSemanticProvenanceWriter().writeCertifiedFacts(
      doc as never,
      structuralCarryIr(block, source),
      before,
    );

    expect(
      materializeCandidateProvenance(doc, [
        { target: source, root: source, birthClass: "writer_protected" },
      ]),
    ).toContainEqual({
      target: textRange(doc),
      root: source,
      birthClass: "writer_protected",
    });
  });

  it("rejects an adjacent block with only partially inserted prose as a structural carry", () => {
    const doc = proseDoc("tail");
    const source = appendVisibleText(doc, "old");
    const fragment = doc.getXmlFragment("prosemirror");
    const block = fragment.get(1) as Y.XmlElement;
    const before = Y.encodeStateVector(doc);
    proseText(doc).insert(0, "new");
    fragment.delete(1, 1);

    expect(() =>
      createSemanticProvenanceWriter().writeCertifiedFacts(
        doc as never,
        structuralCarryIr(block, source),
        before,
      ),
    ).toThrow(ProvenanceMaterializationError);
    expect(doc.getMap(PROVENANCE_TARGETS_TYPE).size).toBe(0);
  });

  it("accepts idempotent facts and blocks conflicting append-only assignments", () => {
    const doc = proseDoc("ab");
    const target = textRange(doc);
    const first = { version: 1 as const, target, root: target };
    expect(() => appendProvenanceFacts(doc, { targets: [first, first] })).not.toThrow();
    expect(() =>
      appendProvenanceFacts(doc, {
        targets: [
          {
            version: 1,
            target,
            root: { clientID: target.clientID + 1, clock: 0, length: target.length },
          },
        ],
      }),
    ).toThrow(/Conflicting append-only target assignment/);
  });

  it("keeps preserved targets rooted in the original writer range across carries", () => {
    const doc = proseDoc("old");
    const root = textRange(doc);
    const first = appendCertifiedCarry(doc, root, "one");
    const second = appendCertifiedCarry(doc, first, "two");

    const visible = materializeCandidateProvenance(doc, [
      { target: root, root, birthClass: "writer_protected" },
    ]);
    expect(visible.find((run) => run.target.clientID === second.clientID)?.root).toEqual(root);
  });

  it("blocks divergent restoration of one root unit to two visible targets", () => {
    const doc = proseDoc("a");
    const root = textRange(doc);
    const first = appendVisibleText(doc, "b");
    const second = appendVisibleText(doc, "c");

    expect(() =>
      appendProvenanceFacts(doc, {
        targets: [
          { version: 1, target: first, root },
          { version: 1, target: second, root },
        ],
      }),
    ).toThrow("One provenance root unit cannot have two visible targets");
  });
});

function proseDoc(value: string): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.push([new Y.XmlText(value)]);
  doc.getXmlFragment("prosemirror").push([paragraph]);
  return doc;
}

function _updateForProse(value: string): Uint8Array {
  const doc = proseDoc(value);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function proseText(doc: Y.Doc): Y.XmlText {
  return proseBlock(doc).get(0) as Y.XmlText;
}

function proseBlock(doc: Y.Doc): Y.XmlElement {
  return doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
}

function structuralCarryIr(
  block: Y.XmlElement,
  source: { clientID: number; clock: number; length: number },
): SemanticEditIRV1 {
  return {
    version: 1,
    documentId: "document",
    inputRevision: "revision" as never,
    scope: [source],
    deleted: [source],
    intent: {
      kind: "mappedEdits",
      edits: [
        {
          edit: {
            kind: "block",
            documentId: "document",
            file: "document.md",
            block: block as never,
            replacement: {} as never,
          },
          outputRuns: [
            {
              kind: "preserved",
              source,
              output: { from: 0, to: source.length },
            },
          ],
        },
      ],
    },
  };
}

function mappedTextIr(
  block: Y.XmlElement,
  source: { clientID: number; clock: number; length: number },
  outputRuns: SemanticOutputRun[],
): SemanticEditIRV1 {
  return {
    version: 1,
    documentId: "document",
    inputRevision: "revision" as never,
    scope: [source],
    deleted: [],
    intent: {
      kind: "mappedEdits",
      edits: [
        {
          edit: {
            kind: "block",
            documentId: "document",
            file: "document.md",
            block: block as never,
            replacement: {} as never,
          },
          outputRuns,
        },
      ],
    },
  };
}

function appendCertifiedCarry(
  doc: Y.Doc,
  source: { clientID: number; clock: number; length: number },
  value: string,
) {
  const before = Y.encodeStateVector(doc);
  const fragment = doc.getXmlFragment("prosemirror");
  if (fragment.length > 0) fragment.delete(fragment.length - 1, 1);
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText(value);
  paragraph.push([text]);
  fragment.push([paragraph]);
  createSemanticProvenanceWriter().writeCertifiedFacts(
    doc as never,
    {
      version: 1,
      documentId: "document",
      inputRevision: "revision" as never,
      scope: [source],
      deleted: [],
      intent: {
        kind: "mappedEdits",
        edits: [
          {
            edit: {
              kind: "block",
              documentId: "document",
              file: "document.md",
              block: paragraph as never,
              replacement: {} as never,
            },
            outputRuns: [{ kind: "preserved", source, output: { from: 0, to: value.length } }],
          },
        ],
      },
    },
    before,
  );
  const id = (text as unknown as { _start: { id: { client: number; clock: number } } })._start.id;
  return { clientID: id.client, clock: id.clock, length: value.length };
}

function appendVisibleText(doc: Y.Doc, value: string) {
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText(value);
  paragraph.push([text]);
  doc.getXmlFragment("prosemirror").push([paragraph]);
  const id = (text as unknown as { _start: { id: { client: number; clock: number } } })._start.id;
  return { clientID: id.client, clock: id.clock, length: value.length };
}

function textRange(doc: Y.Doc) {
  const paragraph = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const text = paragraph.get(0) as Y.XmlText;
  const item = (
    text as unknown as { _start: { id: { client: number; clock: number }; length: number } }
  )._start;
  return { clientID: item.id.client, clock: item.id.clock, length: item.length };
}
