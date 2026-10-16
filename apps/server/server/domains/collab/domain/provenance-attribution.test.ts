/** Consolidated test contracts; each block retains its original fixture scope. */

import {
  normalizeLineageRanges,
  type SemanticEditIRV1,
  type SemanticOutputRun,
} from "@meridian/agent-edit/integration";
import {
  buildDocumentSchema,
  captureUndoRestorationClaims,
  createCollabYDoc,
  RESTORATION_CLAIMS_TYPE,
  type RestorationAlias,
} from "@meridian/prosemirror-schema";
import { Fragment } from "prosemirror-model";
import { describe as __mergedSuite, expect, it } from "vitest";
import * as Y from "yjs";
import { type IndexedDraftUpdate, indexDraftUpdates } from "./draft-review-attribution.js";
import {
  type AttributionManifestV1,
  appendProvenanceFacts,
  createSemanticProvenanceWriter,
  type DocumentAuthorityId,
  journalInsertionRanges,
  materializeCandidateProvenance,
  materializeProvenanceView,
  PROVENANCE_TARGETS_TYPE,
  ProvenanceMaterializationError,
} from "./provenance.js";
import { materializeSweepEvidence } from "./sweep-policy.js";
import { certifyWriterRestorations } from "./writer-restoration.js";

__mergedSuite("provenance.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/provenance.test.ts.
  const schema = buildDocumentSchema();

  /** Plain inline content standing in for a resolved text replacement. */
  function inlineText(text: string): Fragment {
    return text.length === 0 ? Fragment.empty : Fragment.from(schema.text(text));
  }

  const authorityId = "00000000-0000-4000-8000-000000000100" as DocumentAuthorityId;

  const emptyManifest = (): AttributionManifestV1 => ({
    version: 1,
    authorityId,
    generation: 1n,
    checkpointId: "empty-authority-floor",
    floor: null,
    attributions: [],
  });

  __mergedSuite("provenance materialization", () => {
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
        mappedTextIr(proseBlock(doc), source, "kit and cat", [
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
        mappedTextIr(proseBlock(doc), source, "catkit", [
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
          mappedTextIr(proseBlock(doc), source, "XY", [
            { kind: "restoration", root: source, payload: "XY", output: { from: 0, to: 2 } },
          ]),
          before,
        ),
      ).toThrow(/length-for-length/);
    });
    it("locates grouped same-block edits by their final output spans", () => {
      const doc = proseDoc("one two");
      const source = textRange(doc);
      const firstRoot = { ...source, length: 3 };
      const secondRoot = { ...source, clock: source.clock + 4, length: 3 };
      const block = proseBlock(doc);
      const text = proseText(doc);
      const before = Y.encodeStateVector(doc);
      text.delete(4, 3);
      text.insert(4, "TWO");
      text.delete(0, 3);
      text.insert(0, "ONE!");
      createSemanticProvenanceWriter().writeCertifiedFacts(
        doc as never,
        {
          version: 1,
          documentId: "document",
          inputRevision: "revision" as never,
          scope: [firstRoot, secondRoot],
          deleted: [firstRoot, secondRoot],
          intent: {
            kind: "mappedEdits",
            edits: [
              {
                edit: {
                  kind: "textRanges",
                  documentId: "document",
                  file: "document.md",
                  block: block as never,
                  replacements: [{ span: { start: 0, end: 3 }, content: inlineText("ONE!") }],
                  output: "ONE!",
                },
                outputRuns: [
                  {
                    kind: "restoration",
                    root: firstRoot,
                    payload: "ONE",
                    output: { from: 0, to: 3 },
                  },
                  { kind: "fresh", payload: "!", output: { from: 3, to: 4 } },
                ],
              },
              restorationTextEdit(block, secondRoot, 4, "TWO"),
            ],
          },
        },
        before,
      );
      const visible = materializeCandidateProvenance(doc, [
        { target: firstRoot, root: firstRoot, birthClass: "writer_protected" },
        { target: secondRoot, root: secondRoot, birthClass: "writer_protected" },
      ]);
      expect(visible[0]).toMatchObject({
        root: firstRoot,
        birthClass: "writer_protected",
      });
      expect(visible.at(-1)).toMatchObject({
        root: secondRoot,
        birthClass: "writer_protected",
      });
    });
    it("locates equal-anchor insertions in their stable application order", () => {
      const doc = proseDoc("abbase");
      const source = textRange(doc);
      const firstRoot = { ...source, length: 1 };
      const secondRoot = { ...source, clock: source.clock + 1, length: 1 };
      const block = proseBlock(doc);
      const text = proseText(doc);
      const before = Y.encodeStateVector(doc);
      text.delete(0, 2);
      text.insert(0, "A");
      text.insert(0, "B");
      createSemanticProvenanceWriter().writeCertifiedFacts(
        doc as never,
        {
          version: 1,
          documentId: "document",
          inputRevision: "revision" as never,
          scope: [firstRoot, secondRoot],
          deleted: [firstRoot, secondRoot],
          intent: {
            kind: "mappedEdits",
            edits: [
              restorationInsertion(block, firstRoot, "A"),
              restorationInsertion(block, secondRoot, "B"),
            ],
          },
        },
        before,
      );
      const visible = materializeCandidateProvenance(doc, [
        { target: firstRoot, root: firstRoot, birthClass: "writer_protected" },
        { target: secondRoot, root: secondRoot, birthClass: "writer_protected" },
      ]);
      expect(visible[0]).toMatchObject({
        root: secondRoot,
        birthClass: "writer_protected",
      });
      expect(visible[1]).toMatchObject({
        root: firstRoot,
        birthClass: "writer_protected",
      });
    });
    it("locates a certified structural carry from its replaced input block", () => {
      const doc = proseDoc("old");
      const block = proseBlock(doc);
      const source = textRange(doc);
      const before = Y.encodeStateVector(doc);
      const fragment = doc.getXmlFragment("prosemirror");
      fragment.delete(0, 1);
      const replacementBlock = new Y.XmlElement("heading");
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

  __mergedSuite("sweep observation evidence", () => {
    it("keeps each AI candidate's own observation watermark", () => {
      const doc = proseDoc("writer words");
      const update = Y.encodeStateAsUpdate(doc);
      const actorUserId = crypto.randomUUID();
      const rows = [
        {
          authorityId,
          generation: 1n,
          admissionSequence: 1n,
          batchOrdinal: 0,
          journalRowId: 11n,
          originType: "human",
          actorUserId,
          update,
        },
      ];
      const evidence = materializeSweepEvidence({
        rows,
        candidates: [
          {
            precedingUpdates: [],
            update: new Uint8Array(),
            observedBaseUpdateSeq: 10,
            rootFloor: { key: "empty", roots: [] },
          },
          {
            precedingUpdates: [],
            update: new Uint8Array(),
            observedBaseUpdateSeq: 11,
            rootFloor: { key: "empty", roots: [] },
          },
        ],
      });
      expect(evidence.candidates[0]?.byUser).toEqual([
        expect.objectContaining({ userId: actorUserId }),
      ]);
      expect(evidence.candidates[1]?.byUser).toEqual([]);
      doc.destroy();
    });
    it("keeps every recipient while excluding historical, AI, and unknown roots", () => {
      const recentWriters = Array.from({ length: 101 }, () => crypto.randomUUID());
      const historicalDoc = proseDoc("historical");
      const historicalUpdate = Y.encodeStateAsUpdate(historicalDoc);
      const evidence = materializeSweepEvidence({
        rows: [
          {
            journalRowId: 10n,
            originType: "human",
            actorUserId: crypto.randomUUID(),
            update: historicalUpdate,
          },
          {
            journalRowId: 11n,
            originType: "agent",
            actorUserId: null,
            update: updateForProse("agent"),
          },
          {
            journalRowId: 12n,
            originType: null,
            actorUserId: null,
            update: updateForProse("unknown"),
          },
          ...recentWriters.map((actorUserId, index) => {
            const writerDoc = proseDoc(`writer-${index}`);
            const update = Y.encodeStateAsUpdate(writerDoc);
            writerDoc.destroy();
            return {
              journalRowId: BigInt(13 + index),
              originType: "human",
              actorUserId,
              update,
            };
          }),
        ],
        candidates: [
          {
            precedingUpdates: [],
            update: new Uint8Array(),
            observedBaseUpdateSeq: 10,
            rootFloor: { key: "empty", roots: [] },
          },
        ],
      });
      expect(evidence.candidates[0]?.byUser.map(({ userId }) => userId)).toEqual(recentWriters);
      expect(
        evidence.candidates[0]?.byUser.every(
          ({ rootsAfterObservationWatermark }) => rootsAfterObservationWatermark.length > 0,
        ),
      ).toBe(true);
      historicalDoc.destroy();
    });
    it("attributes only a human row's first-born roots when its update repeats older structs", () => {
      const doc = proseDoc("checkpoint text");
      const checkpointUpdate = Y.encodeStateAsUpdate(doc);
      const afterCheckpoint = Y.encodeStateVector(doc);
      appendVisibleText(doc, "old agent text");
      const agentUpdate = Y.encodeStateAsUpdate(doc, afterCheckpoint);
      const beforeNovel = Y.encodeStateVector(doc);
      appendVisibleText(doc, "new writer text");
      const novelUpdate = Y.encodeStateAsUpdate(doc, beforeNovel);
      const repeatedWithNovel = Y.encodeStateAsUpdate(doc);
      const actorUserId = crypto.randomUUID();
      const evidence = materializeSweepEvidence({
        rows: [
          {
            journalRowId: 11n,
            originType: "agent",
            actorUserId: null,
            update: agentUpdate,
          },
          {
            journalRowId: 12n,
            originType: "human",
            actorUserId,
            update: repeatedWithNovel,
          },
        ],
        candidates: [
          {
            precedingUpdates: [],
            update: new Uint8Array(),
            observedBaseUpdateSeq: 10,
            rootFloor: {
              key: "checkpoint",
              roots: journalInsertionRanges(checkpointUpdate),
            },
          },
        ],
      });
      expect(evidence.candidates[0]?.byUser).toEqual([
        {
          userId: actorUserId,
          rootsAfterObservationWatermark: normalizeLineageRanges(
            journalInsertionRanges(novelUpdate),
          ),
        },
      ]);
      doc.destroy();
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

  function updateForProse(value: string): Uint8Array {
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
    source: {
      clientID: number;
      clock: number;
      length: number;
    },
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

  function restorationTextEdit(
    block: Y.XmlElement,
    root: {
      clientID: number;
      clock: number;
      length: number;
    },
    start: number,
    payload: string,
  ) {
    return {
      edit: {
        kind: "textRanges" as const,
        documentId: "document",
        file: "document.md",
        block: block as never,
        replacements: [{ span: { start, end: start + root.length }, content: inlineText(payload) }],
        output: payload,
      },
      outputRuns: [
        {
          kind: "restoration" as const,
          root,
          payload,
          output: { from: 0, to: payload.length },
        },
      ],
    };
  }

  function restorationInsertion(
    block: Y.XmlElement,
    root: {
      clientID: number;
      clock: number;
      length: number;
    },
    payload: string,
  ) {
    return {
      edit: {
        kind: "textRanges" as const,
        documentId: "document",
        file: "document.md",
        block: block as never,
        replacements: [{ span: { start: 0, end: 0 }, content: inlineText(payload) }],
        output: payload,
      },
      outputRuns: [
        {
          kind: "restoration" as const,
          root,
          payload,
          output: { from: 0, to: payload.length },
        },
      ],
    };
  }

  function mappedTextIr(
    block: Y.XmlElement,
    source: {
      clientID: number;
      clock: number;
      length: number;
    },
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
              kind: "textRanges",
              documentId: "document",
              file: "document.md",
              block: block as never,
              replacements: [
                { span: { start: 0, end: source.length }, content: inlineText(output) },
              ],
              output: output,
            },
            outputRuns,
          },
        ],
      },
    };
  }

  function appendCertifiedCarry(
    doc: Y.Doc,
    source: {
      clientID: number;
      clock: number;
      length: number;
    },
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
                kind: "textRanges",
                documentId: "document",
                file: "document.md",
                block: paragraph as never,
                replacements: [
                  { span: { start: 0, end: source.length }, content: inlineText(value) },
                ],
                output: value,
              },
              outputRuns: [{ kind: "preserved", source, output: { from: 0, to: value.length } }],
            },
          ],
        },
      },
      before,
    );
    const id = (
      text as unknown as {
        _start: {
          id: {
            client: number;
            clock: number;
          };
        };
      }
    )._start.id;
    return { clientID: id.client, clock: id.clock, length: value.length };
  }

  function appendVisibleText(doc: Y.Doc, value: string) {
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText(value);
    paragraph.push([text]);
    doc.getXmlFragment("prosemirror").push([paragraph]);
    const id = (
      text as unknown as {
        _start: {
          id: {
            client: number;
            clock: number;
          };
        };
      }
    )._start.id;
    return { clientID: id.client, clock: id.clock, length: value.length };
  }

  function textRange(doc: Y.Doc) {
    const paragraph = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    const item = (
      text as unknown as {
        _start: {
          id: {
            client: number;
            clock: number;
          };
          length: number;
        };
      }
    )._start;
    return { clientID: item.id.client, clock: item.id.clock, length: item.length };
  }
});

__mergedSuite("writer-restoration.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/writer-restoration.test.ts.
  function fixture(trackAi = false) {
    const browser = new Y.Doc({ gc: false });
    browser.clientID = 2001;
    const text = browser.getText("chapter");
    text.insert(0, "The  waits.");
    const baseDoc = new Y.Doc({ gc: false });
    Y.applyUpdate(baseDoc, Y.encodeStateAsUpdate(browser));
    const server = new Y.Doc({ gc: false });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
    const updates: IndexedDraftUpdate[] = [];
    let turn: string | null = "ai-turn";
    let connected = true;
    browser.on("update", (updateData) => {
      if (!connected) return;
      const before = Y.encodeStateVector(server);
      const aliases = certifyWriterRestorations(server, updateData);
      Y.applyUpdate(server, updateData);
      if (
        Buffer.from(before).equals(Buffer.from(Y.encodeStateVector(server))) &&
        Y.decodeUpdate(updateData).ds.clients.size === 0
      )
        return;
      updates.push({
        id: updates.length + 1,
        actorTurnId: turn,
        actorUserId: turn ? null : "writer",
        updateData,
        updateMeta: { restorationAliases: aliases },
      });
    });
    const earlyUndo = trackAi ? new Y.UndoManager(text) : null;
    browser.clientID = 2002;
    text.insert(4, "serpent");
    turn = null;
    browser.clientID = 2003;
    captureUndoRestorationClaims(browser);
    const undo = earlyUndo ?? new Y.UndoManager(text);
    return {
      browser,
      text,
      baseDoc,
      server,
      updates,
      undo,
      disconnect: () => {
        connected = false;
      },
    };
  }

  function authors(f: ReturnType<typeof fixture>) {
    const index = indexDraftUpdates({ baseDoc: f.baseDoc, updates: f.updates });
    const ranges: Array<{
      client: number;
      clock: number;
      length: number;
    }> = [];
    for (const structs of f.server.store.clients.values()) {
      for (const item of structs) {
        if (
          item instanceof Y.Item &&
          !item.deleted &&
          item.parent === f.server.getText("chapter") &&
          item.id.client !== 2001
        )
          ranges.push({ ...item.id, length: item.length });
      }
    }
    return index
      .attributeRanges({ insertedRanges: ranges, deletedRanges: [] })
      .insertedAttribution.map((range) => ({
        ...range,
        author: index.byOperationId.get(range.operationId)?.kind,
      }));
  }

  it("certified Undo and repeated Redo restore the AI author on cold replay", () => {
    const f = fixture();
    f.text.delete(4, 7);
    f.undo.undo();
    expect(f.updates.at(-1)?.updateMeta).toMatchObject({
      restorationAliases: [{ source: { client: 2002 }, target: { client: 2003 } }],
    });
    expect(authors(f)).toMatchObject([{ author: "agent", length: 7 }]);
    f.undo.redo();
    f.undo.undo();
    expect(authors(f)).toMatchObject([{ author: "agent", length: 7 }]);
  });

  it("partial restoration keeps each source's author", () => {
    const f = fixture();
    f.text.insert(11, " GOLD");
    f.undo.stopCapturing();
    f.text.delete(7, 9);
    f.undo.undo();
    expect(f.text.toString()).toBe("The serpent GOLD waits.");
    expect(
      authors(f)
        .filter((span) => span.author === "agent")
        .reduce((sum, span) => sum + span.length, 0),
    ).toBe(7);
    expect(
      authors(f)
        .filter((span) => span.author === "writer")
        .reduce((sum, span) => sum + span.length, 0),
    ).toBe(5);
  });

  it("hand retyping with a forged displaced claim remains writer authored", () => {
    const f = fixture();
    f.text.delete(4, 7);
    f.browser.transact(() => {
      f.text.insert(4, "serpent");
      f.browser.getMap(RESTORATION_CLAIMS_TYPE).set("forged", {
        source: { client: 2002, clock: 0, length: 7 },
        target: { client: 2003, clock: 0, length: 7 },
      });
    });
    expect(f.updates.at(-1)?.updateMeta).toEqual({ restorationAliases: [] });
    expect(authors(f)).toMatchObject([{ author: "writer" }]);
  });

  it("a retried full-state update does not recertify an existing target", () => {
    const f = fixture();
    f.text.delete(4, 7);
    f.undo.undo();
    expect(certifyWriterRestorations(f.server, Y.encodeStateAsUpdate(f.browser))).toEqual([]);
    expect(authors(f)).toMatchObject([{ author: "agent" }]);
  });

  it("Redo of an AI-authored insertion restores its original author", () => {
    const f = fixture(true);
    f.undo.undo();
    expect(f.text.toString()).toBe("The  waits.");
    f.undo.redo();
    expect(authors(f)).toMatchObject([{ author: "agent", length: 7 }]);
  });

  it("offline full-state reconciliation preserves the alias and author", () => {
    const f = fixture();
    f.disconnect();
    f.text.delete(7, 4);
    f.undo.undo();
    const updateData = Y.encodeStateAsUpdate(f.browser);
    const restorationAliases = certifyWriterRestorations(f.server, updateData);
    expect(restorationAliases).toHaveLength(1);
    f.updates.push({
      id: 2,
      actorTurnId: null,
      actorUserId: "writer",
      updateData,
      updateMeta: { restorationAliases },
    });
    Y.applyUpdate(f.server, updateData);
    expect(authors(f).every((span) => span.author === "agent")).toBe(true);
    expect(authors(f).reduce((sum, span) => sum + span.length, 0)).toBe(7);
  });

  it("a claim previously sent without its target cannot certify a future stroke", () => {
    const f = fixture();
    f.text.delete(4, 7);
    f.browser.getMap(RESTORATION_CLAIMS_TYPE).set("stale", {
      source: { client: 2002, clock: 0, length: 7 },
      target: { client: 2003, clock: 1, length: 7 },
    });
    f.text.insert(4, "serpent");
    expect(f.updates.at(-1)?.updateMeta).toEqual({ restorationAliases: [] });
    expect(authors(f)).toMatchObject([{ author: "writer" }]);
  });

  it("a whole deleted paragraph certifies its restored parent chain and text", () => {
    const browser = new Y.Doc({ gc: false });
    browser.clientID = 2002;
    const root = browser.getXmlFragment("prosemirror");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, "serpent");
    root.insert(0, [paragraph]);
    const server = new Y.Doc({ gc: false });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
    browser.clientID = 2003;
    const undo = new Y.UndoManager(root);
    captureUndoRestorationClaims(browser);
    root.delete(0, 1);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
    undo.undo();
    const aliases = certifyWriterRestorations(server, Y.encodeStateAsUpdate(browser));
    expect(aliases).toHaveLength(3);
    expect(aliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: { client: 2002, clock: 2, length: 7 } }),
      ]),
    );
    undo.destroy();
    browser.destroy();
    server.destroy();
  });

  function richRestoration(kind: "attribute" | "rich paragraph", content = "abcdef") {
    const browser = new Y.Doc({ gc: false });
    browser.clientID = 3001;
    const root = browser.getXmlFragment("prosemirror");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, content);
    root.insert(0, [paragraph]);
    browser.clientID = 3004;
    paragraph.setAttribute("align", "left");
    text.format(2, 2, { bold: true });
    const aiUpdate = Y.encodeStateAsUpdate(browser);
    browser.clientID = 3002;
    const undo = new Y.UndoManager(root);
    const stop = captureUndoRestorationClaims(browser);
    if (kind === "attribute") paragraph.setAttribute("align", "right");
    else root.delete(0, 1);
    const server = new Y.Doc({ gc: false });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
    undo.undo();
    const claims = browser.getMap<RestorationAlias>(RESTORATION_CLAIMS_TYPE);
    return {
      browser,
      server,
      root,
      claims,
      aiUpdate,
      certify: () => certifyWriterRestorations(server, Y.encodeStateAsUpdate(browser)),
      destroy: () => {
        stop();
        undo.destroy();
        browser.destroy();
        server.destroy();
      },
    };
  }

  it.each([
    "attribute",
    "rich paragraph",
  ] as const)("certifies only directly proved %s restoration slots and leaves the remainder writer-authored", (kind) => {
    const f = richRestoration(kind);
    const claims = [...f.claims.values()];
    expect(claims).toHaveLength(kind === "attribute" ? 1 : 8);
    expect(f.root.toString()).toBe('<paragraph align="left">ab<bold>cd</bold>ef</paragraph>');
    const restorationAliases = f.certify();
    expect(restorationAliases).toHaveLength(kind === "attribute" ? 0 : 5);
    expect(claims).toEqual(expect.arrayContaining(restorationAliases));
    const baseDoc = new Y.Doc({ gc: false });
    const index = indexDraftUpdates({
      baseDoc,
      updates: [
        { id: 1, actorTurnId: "ai-turn", updateData: f.aiUpdate },
        {
          id: 2,
          actorTurnId: null,
          actorUserId: "writer",
          updateData: Y.encodeStateAsUpdate(f.server),
        },
        {
          id: 3,
          actorTurnId: null,
          actorUserId: "writer",
          updateData: Y.encodeStateAsUpdate(f.browser),
          updateMeta: { restorationAliases },
        },
      ],
    });
    const attribution = index.attributeRanges({
      insertedRanges: claims.map((alias) => alias.target),
      deletedRanges: [],
    });
    expect(attribution.complete).toBe(true);
    expect(attribution.insertedAttribution.reduce((sum, range) => sum + range.length, 0)).toBe(
      kind === "attribute" ? 1 : 11,
    );
    const aiClocks = attribution.insertedAttribution
      .filter((range) => index.byOperationId.get(range.operationId)?.actorTurnId === "ai-turn")
      .reduce((sum, range) => sum + range.length, 0);
    expect(aiClocks).toBe(kind === "attribute" ? 0 : 6);
    baseDoc.destroy();
    f.destroy();
  });

  it("rejects same-content sibling substitutions in a recreated rich paragraph", () => {
    const f = richRestoration("rich paragraph", "ababab");
    const textAliases = [...f.claims.entries()].filter(([, alias]) => {
      const source = f.browser.store.clients
        .get(alias.source.client)
        ?.find((item) => item.id.clock === alias.source.clock);
      return source instanceof Y.Item && source.content instanceof Y.ContentString;
    });
    expect(textAliases).toHaveLength(3);
    const firstEntry = textAliases[0];
    const lastEntry = textAliases[2];
    if (!firstEntry || !lastEntry) throw new Error("Missing text restoration aliases");
    const [firstKey, first] = firstEntry;
    const [lastKey, last] = lastEntry;
    f.browser.transact(() => {
      f.claims.set(firstKey, { source: last.source, target: first.target });
      f.claims.set(lastKey, { source: first.source, target: last.target });
    });
    const certified = f.certify();
    expect(certified.some((alias) => alias.target.clock === first.target.clock)).toBe(false);
    expect(certified.some((alias) => alias.target.clock === last.target.clock)).toBe(false);
    f.destroy();
  });

  it("rejects child claims when the restored container has no certified identity", () => {
    const f = richRestoration("rich paragraph");
    for (const [key, alias] of f.claims) {
      if (alias.source.clock === 0) f.claims.delete(key);
    }
    expect(f.certify()).toEqual([]);
    f.destroy();
  });

  it.each([
    "wrong value",
    "wrong key",
    "oversized range",
  ] as const)("rejects forged attribute restoration with %s", (forgery) => {
    const f = richRestoration("attribute");
    const entry = [...f.claims.entries()][0];
    if (!entry) throw new Error("Missing attribute restoration alias");
    const [key, alias] = entry;
    if (forgery === "oversized range") {
      f.claims.set(key, {
        source: { ...alias.source, length: 2 },
        target: { ...alias.target, length: 2 },
      });
    } else {
      const paragraph = f.root.get(0) as Y.XmlElement;
      // A fresh copy at a different key, or with different content, cannot borrow
      // the original attribute's author even when its predecessor is tombstoned.
      const attribute = forgery === "wrong key" ? "title" : "align";
      const clock =
        Y.decodeStateVector(Y.encodeStateVector(f.browser)).get(f.browser.clientID) ?? 0;
      paragraph.setAttribute(attribute, forgery === "wrong value" ? "center" : "left");
      f.claims.set(key, {
        source: alias.source,
        target: { client: f.browser.clientID, clock, length: 1 },
      });
    }
    expect(f.certify()).toEqual([]);
    f.destroy();
  });

  it("rejects manual equal-value attribute retype with forged claim", () => {
    const browser = new Y.Doc({ gc: false });
    browser.clientID = 4101;
    const paragraph = new Y.XmlElement("paragraph");
    browser.getXmlFragment("prosemirror").insert(0, [paragraph]);
    paragraph.setAttribute("align", "left");
    const source = paragraph._map.get("align");
    if (!source) throw new Error("Missing source attribute");
    browser.clientID = 4102;
    paragraph.setAttribute("align", "right");
    const server = new Y.Doc({ gc: false });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
    const clock = Y.decodeStateVector(Y.encodeStateVector(browser)).get(browser.clientID) ?? 0;
    browser.transact(() => {
      paragraph.setAttribute("align", "left"); // manual edit, no UndoManager
      browser.getMap(RESTORATION_CLAIMS_TYPE).set("forged", {
        source: { ...source.id, length: 1 },
        target: { client: browser.clientID, clock, length: 1 },
      });
    });
    expect(certifyWriterRestorations(server, Y.encodeStateAsUpdate(browser))).toEqual([]);
  });

  it("omitted sibling claims cannot license same-content substitution", () => {
    const f = richRestoration("rich paragraph", "ababab");
    const entries = [...f.claims.entries()];
    const getSource = (alias: RestorationAlias) =>
      f.browser.store.clients
        .get(alias.source.client)
        ?.find((item) => item.id.clock === alias.source.clock);
    const texts = entries.filter(([, alias]) => {
      const item = getSource(alias);
      return item instanceof Y.Item && item.content instanceof Y.ContentString;
    });
    const firstEntry = texts[0];
    const lastEntry = texts[2];
    if (!firstEntry || !lastEntry) throw new Error("Missing text aliases");
    const [firstKey, first] = firstEntry;
    const [, last] = lastEntry;
    for (const [key, alias] of entries) {
      const source = getSource(alias);
      if (!(source instanceof Y.Item && source.content instanceof Y.ContentType))
        f.claims.delete(key);
    }
    f.claims.set(firstKey, { source: last.source, target: first.target });
    expect(f.certify().some((alias) => alias.target.clock === first.target.clock)).toBe(false);
  });

  it("recreated writer text cannot borrow equal AI sibling identity", () => {
    const browser = new Y.Doc({ gc: false });
    browser.clientID = 4201;
    const root = browser.getXmlFragment("prosemirror");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    root.insert(0, [paragraph]);
    text.insert(0, "ab"); // writer authored
    const baseDoc = new Y.Doc({ gc: false });
    Y.applyUpdate(baseDoc, Y.encodeStateAsUpdate(browser));
    const writerSource = { client: 4201, clock: 2, length: 2 };
    browser.clientID = 4202;
    text.insert(2, "ab"); // AI authored
    const aiUpdate = Y.encodeStateAsUpdate(browser);
    const aiSource = { client: 4202, clock: 0, length: 2 };
    browser.clientID = 4203;
    const undo = new Y.UndoManager(root);
    captureUndoRestorationClaims(browser);
    root.delete(0, 1);
    const server = new Y.Doc({ gc: false });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
    undo.undo();
    const claims = browser.getMap<RestorationAlias>(RESTORATION_CLAIMS_TYPE);
    const restoredWriter = [...claims.values()].find(
      (alias) =>
        alias.source.client === writerSource.client && alias.source.clock === writerSource.clock,
    );
    if (!restoredWriter) throw new Error("Missing writer restoration");
    expect(restoredWriter).toBeDefined();
    for (const [key, alias] of claims) {
      if (alias.source.length === 2) claims.delete(key);
    }
    claims.set("forged", { source: aiSource, target: restoredWriter.target });
    const restorationAliases = certifyWriterRestorations(server, Y.encodeStateAsUpdate(browser));
    const index = indexDraftUpdates({
      baseDoc,
      updates: [
        { id: 1, actorTurnId: "ai-turn", updateData: aiUpdate },
        {
          id: 2,
          actorTurnId: null,
          actorUserId: "writer",
          updateData: Y.encodeStateAsUpdate(server),
        },
        {
          id: 3,
          actorTurnId: null,
          actorUserId: "writer",
          updateData: Y.encodeStateAsUpdate(browser),
          updateMeta: { restorationAliases },
        },
      ],
    });
    const attributed = index.attributeRanges({
      insertedRanges: [restoredWriter.target],
      deletedRanges: [],
    });
    expect(
      attributed.insertedAttribution.map(
        (span) => index.byOperationId.get(span.operationId)?.actorTurnId,
      ),
    ).not.toContain("ai-turn");
  });

  it.each([
    false,
    true,
  ])("rejects invalid filler coverage in cold attribution (deleted: %s)", (deleted) => {
    const same = (
      a: {
        client: number;
        clock: number;
      },
      b: {
        client: number;
        clock: number;
      },
    ) => a.client === b.client && a.clock === b.clock;
    const itemAt = (
      doc: Y.Doc,
      id: {
        client: number;
        clock: number;
      },
    ) =>
      (doc.store.clients.get(id.client) ?? []).find(
        (item) => item.id.clock <= id.clock && id.clock < item.id.clock + item.length,
      );
    const browser = new Y.Doc({ gc: false });
    browser.clientID = 4201;
    const root = browser.getXmlFragment("prosemirror");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    root.insert(0, [paragraph]);
    text.insert(0, "ab");
    const baseDoc = new Y.Doc({ gc: false });
    Y.applyUpdate(baseDoc, Y.encodeStateAsUpdate(browser));
    const writerSource = { client: 4201, clock: 2, length: 2 };
    browser.clientID = 4202;
    text.insert(2, "ab");
    const aiUpdate = Y.encodeStateAsUpdate(browser);
    const aiSource = { client: 4202, clock: 0, length: 2 };
    browser.clientID = 4203;
    const undo = new Y.UndoManager(root);
    captureUndoRestorationClaims(browser);
    root.delete(0, 1);
    const server = new Y.Doc({ gc: false });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(browser));
    undo.undo();
    const claims = browser.getMap<RestorationAlias>(RESTORATION_CLAIMS_TYPE);
    const writerAlias = [...claims.entries()].find(([, a]) => same(a.source, writerSource));
    const aiAlias = [...claims.entries()].find(([, a]) => same(a.source, aiSource));
    if (!writerAlias || !aiAlias) throw new Error("missing text aliases");
    const firstTarget = writerAlias[1].target;
    const secondTarget = aiAlias[1].target;
    // The UndoManager recreates the paragraph/text objects; reacquire the live text container.
    const restoredParagraph = root.get(0);
    if (!(restoredParagraph instanceof Y.XmlElement)) throw new Error("missing restored paragraph");
    const restoredText = restoredParagraph.get(0);
    if (!(restoredText instanceof Y.XmlText)) throw new Error("missing restored text");
    // Delete restored second AI `ab`.
    const secondTargetItem = itemAt(browser, secondTarget);
    if (!(secondTargetItem instanceof Y.Item)) throw new Error("missing second target item");
    if (secondTargetItem.parent !== restoredText)
      throw new Error("AI target is not restored text child");
    restoredText.delete(2, 2);
    // Insert zz immediately before restored first writer ab, then delete zz.
    restoredText.insert(0, "zz");
    if (deleted) restoredText.delete(0, 2);
    const zzTargetItem = [...browser.store.clients.values()]
      .flat()
      .find(
        (item) =>
          item instanceof Y.Item &&
          item.parent === restoredText &&
          item.content instanceof Y.ContentString &&
          item.content.str === "zz",
      );
    if (!(zzTargetItem instanceof Y.Item)) throw new Error("missing zz tombstone");
    const liveFirstItem = itemAt(browser, firstTarget);
    if (!(liveFirstItem instanceof Y.Item) || liveFirstItem.deleted)
      throw new Error("first writer target is not live");
    // Keep parent alias. Replace text claims with the requested forged mapping.
    claims.set(writerAlias[0], {
      source: writerSource,
      target: { ...zzTargetItem.id, length: 2 },
    });
    claims.set(aiAlias[0], { source: aiSource, target: { ...liveFirstItem.id, length: 2 } });
    const update = Y.encodeStateAsUpdate(browser);
    const certified = certifyWriterRestorations(server, update);
    const forgedAiAccepted = certified.some(
      (alias) => same(alias.source, aiSource) && same(alias.target, liveFirstItem.id),
    );
    const index = indexDraftUpdates({
      baseDoc,
      updates: [
        { id: 1, actorTurnId: "ai-turn", updateData: aiUpdate },
        {
          id: 2,
          actorTurnId: null,
          actorUserId: "writer",
          updateData: Y.encodeStateAsUpdate(server),
        },
        {
          id: 3,
          actorTurnId: null,
          actorUserId: "writer",
          updateData: update,
          updateMeta: { restorationAliases: certified },
        },
      ],
    });
    const attributed = index.attributeRanges({
      insertedRanges: [{ ...liveFirstItem.id, length: 2 }],
      deletedRanges: [],
    });
    const forgedAiColdAttribution = attributed.insertedAttribution.some(
      (span) => index.byOperationId.get(span.operationId)?.actorTurnId === "ai-turn",
    );
    expect(attributed.complete).toBe(true);
    expect(forgedAiColdAttribution).toBe(false);
    expect(forgedAiAccepted).toBe(false);
    undo.destroy();
    browser.destroy();
    server.destroy();
    baseDoc.destroy();
  });
});
