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

function updateWith(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.getText("prosemirror").insert(0, value);
  return Y.encodeStateAsUpdate(doc);
}

describe("document mutation policy operations", () => {
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
