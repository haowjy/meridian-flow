/** Contract tests for deterministic provenance replay and the reserved namespace. */

import type { SemanticEditIRV1, SemanticOutputRun } from "@meridian/agent-edit";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type AttributionManifestV1,
  appendProvenanceFacts,
  assertClientUpdateOutsideReservedNamespace,
  createSemanticProvenanceWriter,
  type DocumentAuthorityId,
  materializeCandidateProvenance,
  materializeProvenanceView,
  PROVENANCE_ROOTS_TYPE,
  PROVENANCE_TARGETS_TYPE,
  ProvenanceMaterializationError,
  ReservedNamespaceAdmissionError,
} from "./provenance.js";

const authorityId = "00000000-0000-4000-8000-000000000100" as DocumentAuthorityId;
const emptyManifest = (): AttributionManifestV1 => ({
  version: 1,
  authorityId,
  generation: 1n,
  checkpointId: "empty-authority-floor",
  floor: null,
  attributions: [],
});

describe("provenance materialization", () => {
  it("accepts retained output runs without rematerializing their visible roots", () => {
    const doc = proseDoc("cat and cat");
    const source = textRange(doc);
    const retained = { ...source, clock: source.clock + 3, length: 5 };
    const before = Y.encodeStateVector(doc);
    const text = proseText(doc);
    text.delete(8, 3);
    text.insert(8, "kitten");
    text.delete(0, 3);
    text.insert(0, "kitten");

    expect(() =>
      createSemanticProvenanceWriter().writeCertifiedFacts(
        doc as never,
        mappedTextIr(source, "kitten and kitten", [
          { kind: "fresh", payload: "kitten", output: { from: 0, to: 6 } },
          {
            kind: "preserved",
            source: retained,
            output: { from: 6, to: 11 },
            materialization: "retained",
          },
          { kind: "fresh", payload: "kitten", output: { from: 11, to: 17 } },
        ]),
        before,
      ),
    ).not.toThrow();

    const visible = materializeCandidateProvenance(doc, [
      { target: source, root: source, birthClass: "writer_protected" },
    ]);
    expect(visible).toContainEqual({
      target: retained,
      root: retained,
      birthClass: "writer_protected",
    });
  });

  it("writes restoration facts alongside a retained output run", () => {
    const doc = proseDoc("cat and cat");
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
      mappedTextIr(source, "kit and cat", [
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

  it("encodes certified continuation facts in the same Yjs update as prose", () => {
    const doc = proseDoc("old");
    const initial = Y.encodeStateAsUpdate(doc);
    const source = Y.decodeUpdate(initial).structs.find(
      (struct) =>
        (struct as unknown as { content?: { constructor?: { name?: string } } }).content
          ?.constructor?.name === "ContentString",
    );
    if (!source) throw new Error("Expected source text struct");
    const before = Y.encodeStateVector(doc);
    doc.getXmlFragment("prosemirror").delete(0, 1);
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.push([new Y.XmlText("new")]);
    doc.getXmlFragment("prosemirror").push([paragraph]);

    createSemanticProvenanceWriter().writeCertifiedFacts(
      doc as never,
      {
        version: 1,
        documentId: "document",
        inputRevision: "revision" as never,
        scope: [{ clientID: source.id.client, clock: source.id.clock, length: 3 }],
        deleted: [],
        intent: {
          kind: "mappedEdits",
          edits: [
            {
              edit: {
                kind: "text",
                documentId: "document",
                file: "document.md",
                block: {} as never,
                span: { start: 0, end: 3 },
                newText: "new",
              },
              outputRuns: [
                {
                  kind: "preserved",
                  source: { clientID: source.id.client, clock: source.id.clock, length: 3 },
                  output: { from: 0, to: 3 },
                },
              ],
            },
          ],
        },
      },
      before,
    );

    const replica = createCollabYDoc({ gc: false });
    Y.applyUpdate(replica, initial);
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc, before));
    expect(replica.getXmlFragment("prosemirror").toString()).toContain("new");
    expect(replica.getArray(PROVENANCE_TARGETS_TYPE)).toHaveLength(1);
  });

  it("attributes a pending insertion to the row that originated its clocks", () => {
    const source = createCollabYDoc({ gc: false });
    const fragment = source.getXmlFragment("prosemirror");
    const paragraph = new Y.XmlElement("paragraph");
    fragment.push([paragraph]);
    const parentUpdate = Y.encodeStateAsUpdate(source);
    const parentVector = Y.encodeStateVector(source);
    const text = new Y.XmlText("writer words");
    paragraph.push([text]);
    const childUpdate = Y.encodeStateAsUpdate(source, parentVector);

    const result = materializeProvenanceView({
      authorityId,
      generation: 1n,
      manifest: emptyManifest(),
      rows: [
        {
          authorityId,
          generation: 1n,
          admissionSequence: 1n,
          batchOrdinal: 0,
          journalRowId: 10n,
          originType: "agent",
          actorUserId: null,
          update: childUpdate,
        },
        {
          authorityId,
          generation: 1n,
          admissionSequence: 2n,
          batchOrdinal: 0,
          journalRowId: 11n,
          originType: "human",
          actorUserId: crypto.randomUUID(),
          update: parentUpdate,
        },
      ],
      watermark: { admissionSequence: 2n, batchOrdinal: 0, journalRowId: 11n },
    });

    expect(result.doc.getXmlFragment("prosemirror").toString()).toContain("writer words");
    expect(result.visible).toHaveLength(1);
    expect(result.visible[0]?.birthClass).toBe("agent");
    expect(result.visible[0]?.target).toEqual(result.visible[0]?.root);
  });

  it("keeps the first attribution when a later sync update repeats integrated structs", () => {
    const source = proseDoc("writer words");
    const fullSync = Y.encodeStateAsUpdate(source);

    const result = materializeProvenanceView({
      authorityId,
      generation: 1n,
      manifest: emptyManifest(),
      rows: [
        {
          authorityId,
          generation: 1n,
          admissionSequence: 1n,
          batchOrdinal: 0,
          journalRowId: 10n,
          originType: "human",
          actorUserId: crypto.randomUUID(),
          update: fullSync,
        },
        {
          authorityId,
          generation: 1n,
          admissionSequence: 2n,
          batchOrdinal: 0,
          journalRowId: 11n,
          originType: "agent",
          actorUserId: null,
          update: fullSync,
        },
      ],
      watermark: { admissionSequence: 2n, batchOrdinal: 0, journalRowId: 11n },
    });

    expect(result.visible).toHaveLength(1);
    expect(result.visible[0]?.birthClass).toBe("writer_protected");
  });

  it("blocks missing replay rows and missing checkpoint attribution", () => {
    const doc = proseDoc("unattributed");
    const update = Y.encodeStateAsUpdate(doc);
    expect(() =>
      materializeProvenanceView({
        authorityId,
        generation: 1n,
        manifest: emptyManifest(),
        rows: [row(2n, 2n, update)],
        watermark: { admissionSequence: 2n, batchOrdinal: 0, journalRowId: 2n },
      }),
    ).toThrow(/missing a row/);

    expect(() =>
      materializeProvenanceView({
        authorityId,
        generation: 1n,
        checkpointUpdate: update,
        manifest: emptyManifest(),
        rows: [],
        watermark: { admissionSequence: 0n, batchOrdinal: 0, journalRowId: 0n },
      }),
    ).toThrow(ProvenanceMaterializationError);
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

  it("retains a certified target fact after the carried prose is deleted", () => {
    const doc = proseDoc("old");
    const root = textRange(doc);
    doc.getXmlFragment("prosemirror").delete(0, 1);
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText("new");
    paragraph.push([text]);
    doc.getXmlFragment("prosemirror").push([paragraph]);
    const targetId = (text as unknown as { _start: { id: { client: number; clock: number } } })
      ._start.id;
    const target = {
      clientID: targetId.client,
      clock: targetId.clock,
      length: 3,
    };
    appendProvenanceFacts(doc, { targets: [{ version: 1, target, root }] });
    doc.getXmlFragment("prosemirror").delete(0, 1);

    expect(() =>
      materializeCandidateProvenance(doc, [{ target: root, root, birthClass: "writer_protected" }]),
    ).not.toThrow();
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

describe("hostile reserved namespace guard", () => {
  it.each([
    ["ordinary-client overwrite", (doc: Y.Doc) => doc.getArray(PROVENANCE_TARGETS_TYPE).push([{}])],
    [
      "nested insert",
      (doc: Y.Doc) => {
        const nested = doc.getArray(PROVENANCE_TARGETS_TYPE).get(0) as Y.Array<unknown>;
        nested.push(["hostile"]);
      },
    ],
    ["top-level collision", (doc: Y.Doc) => doc.getMap(PROVENANCE_ROOTS_TYPE).set("x", 1)],
  ])("rejects %s", (_name, mutate) => {
    const authority = authorityWithNestedReservedType();
    const update = hostileDelta(authority, mutate);
    expect(() => assertClientUpdateOutsideReservedNamespace(authority, update)).toThrow(
      ReservedNamespaceAdmissionError,
    );
  });

  it("rejects a delete-only reserved change", () => {
    const authority = authorityWithNestedReservedType();
    const update = hostileDelta(authority, (client) => {
      client.getArray(PROVENANCE_TARGETS_TYPE).delete(0, 1);
    });
    expect(Y.decodeUpdate(update).structs).toHaveLength(0);
    expect(() => assertClientUpdateOutsideReservedNamespace(authority, update)).toThrow(
      /deletes reserved provenance state/,
    );
  });

  it("allows ordinary prose updates without scratch-applying them", () => {
    const authority = authorityWithNestedReservedType();
    const client = createCollabYDoc({ gc: false });
    Y.applyUpdate(client, Y.encodeStateAsUpdate(authority));
    const vector = Y.encodeStateVector(client);
    client.getXmlFragment("prosemirror").push([new Y.XmlElement("paragraph")]);
    expect(() =>
      assertClientUpdateOutsideReservedNamespace(authority, Y.encodeStateAsUpdate(client, vector)),
    ).not.toThrow();
  });
});

function row(admissionSequence: bigint, journalRowId: bigint, update: Uint8Array) {
  return {
    authorityId,
    generation: 1n,
    admissionSequence,
    batchOrdinal: 0,
    journalRowId,
    originType: "human",
    actorUserId: crypto.randomUUID(),
    update,
  };
}

function proseDoc(value: string): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.push([new Y.XmlText(value)]);
  doc.getXmlFragment("prosemirror").push([paragraph]);
  return doc;
}

function proseText(doc: Y.Doc): Y.XmlText {
  const paragraph = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  return paragraph.get(0) as Y.XmlText;
}

function mappedTextIr(
  source: { clientID: number; clock: number; length: number },
  output: string,
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
            kind: "text",
            documentId: "document",
            file: "document.md",
            block: {} as never,
            span: { start: 0, end: source.length },
            newText: output,
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
              kind: "text",
              documentId: "document",
              file: "document.md",
              block: {} as never,
              span: { start: 0, end: source.length },
              newText: value,
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

function authorityWithNestedReservedType(): Y.Doc {
  const doc = proseDoc("safe prose");
  const nested = new Y.Array<unknown>();
  doc.getArray(PROVENANCE_TARGETS_TYPE).push([nested]);
  nested.push(["server fact"]);
  return doc;
}

function hostileDelta(authority: Y.Doc, mutate: (client: Y.Doc) => void): Uint8Array {
  const client = createCollabYDoc({ gc: false });
  Y.applyUpdate(client, Y.encodeStateAsUpdate(authority));
  const vector = Y.encodeStateVector(client);
  mutate(client);
  return Y.encodeStateAsUpdate(client, vector);
}
