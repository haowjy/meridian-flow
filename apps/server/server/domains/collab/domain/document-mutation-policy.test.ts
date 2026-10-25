/** Operation-specific contract tests for document mutation admission policy.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Checkpoints carry attribution manifests
 */

import type { DocumentRevision } from "@meridian/contracts";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  type AuthorityGenerationReplacementPort,
  admitSegmentRows,
  DocumentMutationPolicyError,
  replaceAuthorityGeneration,
  replicateFrozenSource,
} from "./document-mutation-policy.js";
import type { AppendDraftJournalInput } from "./draft-store.js";
import {
  appendProvenanceFacts,
  primeReservedNamespaceIndex,
  validateClientUpdateAdmission,
} from "./provenance.js";

const revision = "revision-1" as DocumentRevision;

function updateWith(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.getText("prosemirror").insert(0, value);
  return Y.encodeStateAsUpdate(doc);
}

function fullReplacementIr() {
  return {
    version: 1 as const,
    documentId: "doc-1",
    inputRevision: revision,
    scope: [],
    intent: { kind: "fullScopeFreshReplacement" as const, payload: "agent" },
    deleted: [],
  };
}

describe("document mutation policy operations", () => {
  it("admits reconnect tombstones of server roots but refuses a new base deletion", () => {
    const room = new Y.Doc({ gc: false });
    room.clientID = 1;
    room.getArray("review_base").push(["old", "current"]);
    primeReservedNamespaceIndex(room);
    const peer = new Y.Doc({ gc: false });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(room));
    peer.clientID = 123456;
    peer.getArray("review_base").delete(0, 1);
    const deletion = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(room));
    expect(() => validateClientUpdateAdmission(room, deletion)).toThrow("deletes reserved");
    room.getArray("review_base").delete(0, 1);
    peer.getText("prosemirror").insert(0, "typing after reconnect");
    const reconnect = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(room));
    expect(validateClientUpdateAdmission(room, reconnect)).toEqual({ reservedClientId: null });
    peer.getArray("review_base").delete(0, 1);
    const mixed = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(room));
    expect(() => validateClientUpdateAdmission(room, mixed)).toThrow("deletes reserved");
    peer.destroy();
    room.destroy();
  });

  it("validates a semantic edit's IR before any of its rows applies", () => {
    const target = new Y.Doc({ gc: false });
    const before = Y.encodeStateAsUpdate(target);
    const row: AppendDraftJournalInput = {
      draftId: "draft-1",
      source: "agent",
      updateData: updateWith("agent"),
      semanticEditIr: fullReplacementIr(),
    };

    expect(() => admitSegmentRows(target, "doc-2", [row])).toThrow("different document");
    expect(Y.encodeStateAsUpdate(target)).toEqual(before);
  });

  it("rejects non-injective identity replication before the target applies it", () => {
    const base = proseDoc("a");
    const root = textRange(base);
    const target = cloneDoc(base);
    const source = cloneDoc(base);
    carryToRoot(target, root, "t");
    carryToRoot(source, root, "s");
    const beforeTarget = Y.encodeStateAsUpdate(target);

    expect(() => replicateFrozenSource(source, target)).toThrow(
      "One provenance root unit cannot have two visible targets",
    );
    expect(Y.encodeStateAsUpdate(target)).toEqual(beforeTarget);
  });

  it("replicates a live state that holds a writer's garbage-collected structs", () => {
    // A writer's gc-enabled editor collects prose it deleted before syncing, so its update
    // carries GC structs that the live document keeps verbatim.
    const writer = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.push([new Y.XmlText("draft")]);
    writer.getXmlFragment("prosemirror").push([paragraph, new Y.XmlElement("paragraph")]);
    writer.getXmlFragment("prosemirror").delete(0, 1);
    const live = new Y.Doc({ gc: false });
    const writerUpdate = Y.encodeStateAsUpdate(writer);
    expect(validateClientUpdateAdmission(live, writerUpdate)).toEqual({ reservedClientId: null });
    Y.applyUpdate(live, writerUpdate);
    const target = new Y.Doc({ gc: false });

    replicateFrozenSource(live, target);

    expect(Y.encodeStateVector(target)).toEqual(Y.encodeStateVector(live));
  });

  it("rejects Y.Doc-only checkpoints rather than re-minting provenance", async () => {
    const port = replacementPort({
      loadCheckpoint: vi.fn(async () => ({
        checkpointId: "checkpoint-1",
        state: updateWith("checkpoint"),
        attributionManifest: null,
      })),
    });

    await expect(replaceAuthorityGeneration(port, "checkpoint-1")).rejects.toBeInstanceOf(
      DocumentMutationPolicyError,
    );
  });
});

function replacementPort(
  overrides: Partial<AuthorityGenerationReplacementPort> = {},
): AuthorityGenerationReplacementPort {
  const checkpoint = {
    checkpointId: "checkpoint-1",
    state: updateWith("checkpoint"),
    attributionManifest: { version: 1, floor: null, attributions: [] },
  };
  return {
    readMutationTarget: vi.fn(() => ({
      documentId: "doc-1",
      generation: 3n,
      doc: new Y.Doc({ gc: false }),
    })),
    loadCheckpoint: vi.fn(async () => checkpoint),
    replaceGeneration: vi.fn(async () => 4n),
    disconnectGeneration: vi.fn(async () => undefined),
    ...overrides,
  };
}

function proseDoc(value: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.push([new Y.XmlText(value)]);
  doc.getXmlFragment("prosemirror").push([paragraph]);
  return doc;
}

function cloneDoc(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

function textRange(doc: Y.Doc) {
  const paragraph = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const text = paragraph.get(0) as Y.XmlText;
  const id = (text as unknown as { _start: { id: { client: number; clock: number } } })._start.id;
  return { clientID: id.client, clock: id.clock, length: text.length };
}

function carryToRoot(
  doc: Y.Doc,
  root: { clientID: number; clock: number; length: number },
  value: string,
): void {
  doc.getXmlFragment("prosemirror").delete(0, 1);
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText(value);
  paragraph.push([text]);
  doc.getXmlFragment("prosemirror").push([paragraph]);
  appendProvenanceFacts(doc, { targets: [{ version: 1, target: textRange(doc), root }] });
}
