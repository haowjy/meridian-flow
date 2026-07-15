/** Contract tests for deterministic provenance replay and the reserved namespace. */

import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type AttributionManifestV1,
  appendProvenanceFacts,
  assertClientUpdateOutsideReservedNamespace,
  type DocumentAuthorityId,
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
          birthClass: "agent",
          update: childUpdate,
        },
        {
          authorityId,
          generation: 1n,
          admissionSequence: 2n,
          batchOrdinal: 0,
          journalRowId: 11n,
          birthClass: "writer_protected",
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
    birthClass: "writer_protected" as const,
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
