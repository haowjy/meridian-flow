// Strategy and fencing contract for the single document mutation authority.
import type { DocumentRevision } from "@meridian/contracts";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createDocumentAuthority,
  DocumentAuthorityError,
  type DocumentAuthorityPort,
  type FrozenAuthorityCut,
} from "./document-authority.js";

const revision = "revision-1" as DocumentRevision;

function updateWith(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.getText("prosemirror").insert(0, value);
  return Y.encodeStateAsUpdate(doc);
}

function fakePort(overrides: Partial<DocumentAuthorityPort> = {}): DocumentAuthorityPort {
  const doc = new Y.Doc({ gc: false });
  return {
    admitImmediate: vi.fn(async () => ({ sequence: 4n, joined: 2 })),
    readMutableAuthority: vi.fn(async () => ({ documentId: "doc-1", generation: 3n, doc })),
    readFrozenCut: vi.fn(async () => null),
    readCurrentRevision: vi.fn(async () => revision),
    lowerCertifiedMutation: vi.fn(async () => updateWith("agent")),
    loadCheckpoint: vi.fn(async () => null),
    unresolvedSettlements: vi.fn(async () => 0),
    replaceGeneration: vi.fn(async () => 4n),
    disconnectGeneration: vi.fn(async () => undefined),
    stagePush: vi.fn(async () => "push-1"),
    completePush: vi.fn(async () => undefined),
    ...overrides,
  };
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

function frozenCut(doc: Y.Doc, generation = 1n): FrozenAuthorityCut {
  return { cutId: "cut-1", authorityId: "authority-1", generation, doc };
}

describe("DocumentAuthority", () => {
  it("admits writer restore as exact fresh writer-protected authorship", async () => {
    const port = fakePort();
    const update = updateWith("restored");
    await createDocumentAuthority(port).mutate({
      kind: "attributedFreshAuthorship",
      source: { kind: "writer" },
      update,
    });
    expect(port.admitImmediate).toHaveBeenCalledWith({
      update,
      attribution: { kind: "writer" },
    });
  });

  it("requires explicit import/seed policy", async () => {
    const port = fakePort();
    await expect(
      createDocumentAuthority(port).mutate({
        kind: "attributedFreshAuthorship",
        source: { kind: "import", policy: "unknown" } as never,
        update: updateWith("import"),
      }),
    ).rejects.toMatchObject({ code: "invalid_mutation" });
    expect(port.admitImmediate).not.toHaveBeenCalled();
  });

  it("validates semantic IR and requires retained certificates for agent restoration", async () => {
    const port = fakePort();
    const ir = fullReplacementIr();
    await createDocumentAuthority(port).mutate({
      kind: "certifiedSemanticMutation",
      actor: "agent",
      ir,
    });
    expect(port.lowerCertifiedMutation).toHaveBeenCalledWith(ir);
    expect(port.admitImmediate).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: { kind: "agent" } }),
    );

    const restoration = {
      ...ir,
      intent: {
        kind: "mappedEdits" as const,
        edits: [
          {
            edit: { kind: "insert" as const, documentId: "doc-1", file: "doc.md", newText: "x" },
            outputRuns: [
              {
                kind: "restoration" as const,
                root: { clientID: 9, clock: 0, length: 1 },
                payload: "x",
                output: { from: 0, to: 1 },
              },
            ],
          },
        ],
      },
    };
    await expect(
      createDocumentAuthority(fakePort()).mutate({
        kind: "certifiedSemanticMutation",
        actor: "agent",
        ir: restoration,
      }),
    ).rejects.toThrow("retained root certificate");
  });

  it("computes identity replication bytes from a frozen source cut", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "source");
    const port = fakePort({ readFrozenCut: vi.fn(async () => frozenCut(source)) });
    await createDocumentAuthority(port).mutate({
      kind: "identityReplication",
      sourceAuthorityCutId: "cut-1",
      plan: { kind: "wholeDocument" },
    });
    const admission = vi.mocked(port.admitImmediate).mock.calls[0]?.[0];
    const replica = new Y.Doc({ gc: false });
    Y.applyUpdate(replica, admission?.update ?? new Uint8Array());
    expect(replica.getText("prosemirror").toString()).toBe("source");
  });

  it("rejects a source-generation race before admission", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "source");
    let read = 0;
    const port = fakePort({
      readFrozenCut: vi.fn(async () => frozenCut(source, ++read === 1 ? 1n : 2n)),
    });
    await expect(
      createDocumentAuthority(port).mutate({
        kind: "identityReplication",
        sourceAuthorityCutId: "cut-1",
        plan: { kind: "wholeDocument" },
      }),
    ).rejects.toMatchObject({ code: "stale_source_authority" });
    expect(port.admitImmediate).not.toHaveBeenCalled();
  });

  it("refuses replacement while old-generation settlement is unresolved", async () => {
    const port = fakePort({
      loadCheckpoint: vi.fn(async () => ({
        checkpointId: "checkpoint-1",
        state: updateWith("old"),
        attributionManifest: { version: 1 },
      })),
      unresolvedSettlements: vi.fn(async () => 1),
    });
    await expect(
      createDocumentAuthority(port).mutate({
        kind: "authoritySnapshotReplacement",
        checkpointId: "checkpoint-1",
        replaceGeneration: true,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "authority_busy" }));
    expect(port.replaceGeneration).not.toHaveBeenCalled();
  });

  it("installs a complete checkpoint as a new generation and fences old clients", async () => {
    const checkpoint = {
      checkpointId: "checkpoint-1",
      state: updateWith("checkpoint"),
      attributionManifest: { version: 1, floor: null, attributions: [] },
    };
    const port = fakePort({ loadCheckpoint: vi.fn(async () => checkpoint) });
    await expect(
      createDocumentAuthority(port).mutate({
        kind: "authoritySnapshotReplacement",
        checkpointId: "checkpoint-1",
        replaceGeneration: true,
      }),
    ).resolves.toEqual({ generation: 4n });
    expect(port.replaceGeneration).toHaveBeenCalledWith(checkpoint, 3n);
    expect(port.disconnectGeneration).toHaveBeenCalledWith(3n);
  });

  it("rejects Y.Doc-only checkpoints rather than re-minting provenance", async () => {
    const port = fakePort({
      loadCheckpoint: vi.fn(async () => ({
        checkpointId: "checkpoint-1",
        state: updateWith("checkpoint"),
        attributionManifest: null,
      })),
    });
    await expect(
      createDocumentAuthority(port).mutate({
        kind: "authoritySnapshotReplacement",
        checkpointId: "checkpoint-1",
        replaceGeneration: true,
      }),
    ).rejects.toBeInstanceOf(DocumentAuthorityError);
  });

  it("exposes staged push and same-generation completion fences", async () => {
    const port = fakePort();
    const authority = createDocumentAuthority(port);
    await expect(
      authority.stagePush({ update: updateWith("push"), expectedGeneration: 3n }),
    ).resolves.toBe("push-1");
    await authority.completePush({ stagedPushId: "push-1", expectedGeneration: 3n });
    expect(port.completePush).toHaveBeenCalledWith({
      stagedPushId: "push-1",
      expectedGeneration: 3n,
    });
  });
});
