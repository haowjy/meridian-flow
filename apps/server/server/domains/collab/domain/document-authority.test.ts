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
import { PROVENANCE_ROOTS_TYPE } from "./provenance.js";

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

  it("selectively replicates named shared types and carries delete-only state", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "kept");
    source.getText("companion").insert(0, "excluded");
    const beforeDelete = Y.encodeStateVector(source);
    source.getText("deleted").insert(0, "gone");
    source.getText("deleted").delete(0, 4);
    expect(Y.encodeStateAsUpdate(source, beforeDelete).byteLength).toBeGreaterThan(0);
    const port = fakePort({ readFrozenCut: vi.fn(async () => frozenCut(source)) });
    await createDocumentAuthority(port).mutate({
      kind: "identityReplication",
      sourceAuthorityCutId: "cut-1",
      plan: { kind: "sharedTypes", names: ["prosemirror"] },
    });
    const admission = vi.mocked(port.admitImmediate).mock.calls[0]?.[0];
    const replica = new Y.Doc({ gc: false });
    Y.applyUpdate(replica, admission?.update ?? new Uint8Array());
    expect(replica.getText("prosemirror").toString()).toBe("kept");
    expect(replica.getText("companion").toString()).toBe("");
    expect(replica.getText("deleted").toString()).toBe("");
  });

  it("round-trips live to work to thread to live with reserved facts intact", async () => {
    const live = new Y.Doc({ gc: false });
    live.getText("prosemirror").insert(0, "chapter");
    live.getMap(PROVENANCE_ROOTS_TYPE).set("root-1", { policy: "agent" });
    const work = new Y.Doc({ gc: false });
    const thread = new Y.Doc({ gc: false });
    await replicateInto(live, work, { kind: "wholeDocument" });
    await replicateInto(work, thread, { kind: "wholeDocument" });
    thread.getText("prosemirror").insert(7, " draft");
    await replicateInto(thread, live, { kind: "wholeDocument" });

    expect(live.getText("prosemirror").toString()).toBe("chapter draft");
    expect(live.getMap(PROVENANCE_ROOTS_TYPE).toJSON()).toEqual({
      "root-1": { policy: "agent" },
    });
  });

  it("carries a delete-only diff from the frozen source cut", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "delete me");
    const target = new Y.Doc({ gc: false });
    Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
    source.getText("prosemirror").delete(0, source.getText("prosemirror").length);

    await replicateInto(source, target, { kind: "sharedTypes", names: ["prosemirror"] });
    expect(target.getText("prosemirror").toString()).toBe("");
  });

  it("uses the named frozen cut when the mutable source advances before admission", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "named cut");
    const frozen = new Y.Doc({ gc: false });
    Y.applyUpdate(frozen, Y.encodeStateAsUpdate(source));
    source.getText("prosemirror").insert(source.getText("prosemirror").length, " later");
    const port = fakePort({ readFrozenCut: vi.fn(async () => frozenCut(frozen)) });

    await createDocumentAuthority(port).mutate({
      kind: "identityReplication",
      sourceAuthorityCutId: "cut-1",
      plan: { kind: "wholeDocument" },
    });
    const admitted = vi.mocked(port.admitImmediate).mock.calls[0]?.[0].update;
    const replica = new Y.Doc({ gc: false });
    Y.applyUpdate(replica, admitted);
    expect(replica.getText("prosemirror").toString()).toBe("named cut");
  });

  it("rejects client-authored reserved-type changes", async () => {
    const authority = new Y.Doc({ gc: false });
    const client = new Y.Doc({ gc: false });
    client.getMap(PROVENANCE_ROOTS_TYPE).set("hostile", { policy: "writer_protected" });
    const port = fakePort({
      readMutableAuthority: vi.fn(async () => ({
        documentId: "doc-1",
        generation: 3n,
        doc: authority,
      })),
    });
    await expect(
      createDocumentAuthority(port).mutate({
        kind: "attributedFreshAuthorship",
        source: { kind: "writer" },
        update: Y.encodeStateAsUpdate(client),
      }),
    ).rejects.toMatchObject({ code: "invalid_mutation" });
    expect(port.admitImmediate).not.toHaveBeenCalled();
  });

  it("joins writer, certified, and replication admissions as one exact containing update", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "replicated");
    const certified = updateWith("certified");
    const port = fakePort({
      admitImmediate: vi.fn(async () => ({ sequence: 7n, joined: 1 })),
      lowerCertifiedMutation: vi.fn(async () => certified),
      readFrozenCut: vi.fn(async () => frozenCut(source)),
    });
    const authority = createDocumentAuthority(port);
    const writer = await authority.mutate({
      kind: "attributedFreshAuthorship",
      source: { kind: "writer" },
      update: updateWith("writer"),
    });
    const agent = await authority.mutate({
      kind: "certifiedSemanticMutation",
      actor: "agent",
      ir: fullReplacementIr(),
    });
    const replication = await authority.mutate({
      kind: "identityReplication",
      sourceAuthorityCutId: "cut-1",
      plan: { kind: "wholeDocument" },
    });
    expect([writer.joined, agent.joined, replication.joined]).toEqual([1, 1, 1]);
    expect(port.admitImmediate).toHaveBeenCalledTimes(3);
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

async function replicateInto(
  source: Y.Doc,
  target: Y.Doc,
  plan: { kind: "wholeDocument" } | { kind: "sharedTypes"; names: readonly string[] },
): Promise<void> {
  const port = fakePort({
    readMutableAuthority: vi.fn(async () => ({
      documentId: "target",
      generation: 1n,
      doc: target,
    })),
    readFrozenCut: vi.fn(async () => frozenCut(source)),
    admitImmediate: vi.fn(async ({ update }) => {
      Y.applyUpdate(target, update);
      return { sequence: 1n, joined: 0 };
    }),
  });
  await createDocumentAuthority(port).mutate({
    kind: "identityReplication",
    sourceAuthorityCutId: "cut-1",
    plan,
  });
}
