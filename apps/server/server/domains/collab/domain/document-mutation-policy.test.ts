/** Operation-specific contract tests for document mutation admission policy.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Checkpoints carry attribution manifests
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  type AuthorityGenerationReplacementPort,
  DocumentMutationPolicyError,
  replaceAuthorityGeneration,
} from "./document-mutation-policy.js";
import { primeReservedNamespaceIndex, validateClientUpdateAdmission } from "./provenance.js";

function updateWith(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.getText("prosemirror").insert(0, value);
  return Y.encodeStateAsUpdate(doc);
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
