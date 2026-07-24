// Strategy and fencing contract for the single document mutation policy.
import type { DocumentRevision } from "@meridian/contracts";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createDocumentMutationPolicy,
  DocumentMutationPolicyError,
  type DocumentMutationPolicyPort,
  type FrozenReplicationSource,
} from "./document-mutation-policy.js";
import { appendProvenanceFacts, PROVENANCE_ROOTS_TYPE } from "./provenance.js";

const revision = "revision-1" as DocumentRevision;

function updateWith(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.getText("prosemirror").insert(0, value);
  return Y.encodeStateAsUpdate(doc);
}

function fakePort(overrides: Partial<DocumentMutationPolicyPort> = {}): DocumentMutationPolicyPort {
  const doc = new Y.Doc({ gc: false });
  return {
    admitImmediate: vi.fn(async () => ({ sequence: 4n, joined: 2 })),
    readMutationTarget: vi.fn(async () => ({ documentId: "doc-1", generation: 3n, doc })),
    readFrozenReplicationSource: vi.fn(async () => null),
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

function frozenSource(doc: Y.Doc, version = 1n, documentId = "doc-1"): FrozenReplicationSource {
  return { cutId: "cut-1", documentId, sourceId: "source-1", version, doc };
}

describe("DocumentMutationPolicy", () => {
  it("admits writer restore as exact fresh writer-protected authorship", async () => {
    const port = fakePort();
    const update = updateWith("restored");
    await createDocumentMutationPolicy(port).mutate({
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
      createDocumentMutationPolicy(port).mutate({
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
    await createDocumentMutationPolicy(port).mutate({
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
    const rejectingPort = fakePort();
    await expect(
      createDocumentMutationPolicy(rejectingPort).mutate({
        kind: "certifiedSemanticMutation",
        actor: "agent",
        ir: restoration,
      }),
    ).rejects.toThrow("retained root certificate");
    expect(rejectingPort.lowerCertifiedMutation).not.toHaveBeenCalled();
    expect(rejectingPort.admitImmediate).not.toHaveBeenCalled();
  });

  it("rejects cross-document IR before lowering or admission", async () => {
    const port = fakePort();
    await expect(
      createDocumentMutationPolicy(port).mutate({
        kind: "certifiedSemanticMutation",
        actor: "agent",
        ir: { ...fullReplacementIr(), documentId: "doc-2" },
      }),
    ).rejects.toThrow("different document");
    expect(port.lowerCertifiedMutation).not.toHaveBeenCalled();
    expect(port.admitImmediate).not.toHaveBeenCalled();
  });

  it("computes identity replication bytes from a frozen source cut", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "source");
    const port = fakePort({ readFrozenReplicationSource: vi.fn(async () => frozenSource(source)) });
    await createDocumentMutationPolicy(port).mutate({
      kind: "identityReplication",
      sourceCutId: "cut-1",
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
    const port = fakePort({ readFrozenReplicationSource: vi.fn(async () => frozenSource(source)) });
    await createDocumentMutationPolicy(port).mutate({
      kind: "identityReplication",
      sourceCutId: "cut-1",
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
    live.getArray(PROVENANCE_ROOTS_TYPE);
    const work = new Y.Doc({ gc: false });
    const thread = new Y.Doc({ gc: false });
    await replicateInto(live, work, { kind: "wholeDocument" });
    await replicateInto(work, thread, { kind: "wholeDocument" });
    thread.getText("prosemirror").insert(7, " draft");
    await replicateInto(thread, live, { kind: "wholeDocument" });

    expect(live.getText("prosemirror").toString()).toBe("chapter draft");
    expect(live.getArray(PROVENANCE_ROOTS_TYPE).toJSON()).toEqual([]);
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
    const port = fakePort({ readFrozenReplicationSource: vi.fn(async () => frozenSource(frozen)) });

    await createDocumentMutationPolicy(port).mutate({
      kind: "identityReplication",
      sourceCutId: "cut-1",
      plan: { kind: "wholeDocument" },
    });
    const admitted = vi.mocked(port.admitImmediate).mock.calls[0]?.[0].update;
    const replica = new Y.Doc({ gc: false });
    Y.applyUpdate(replica, admitted);
    expect(replica.getText("prosemirror").toString()).toBe("named cut");
  });

  it("rejects client-authored reserved-type changes", async () => {
    const targetDocument = new Y.Doc({ gc: false });
    const client = new Y.Doc({ gc: false });
    client.getMap(PROVENANCE_ROOTS_TYPE).set("hostile", { policy: "writer_protected" });
    const port = fakePort({
      readMutationTarget: vi.fn(async () => ({
        documentId: "doc-1",
        generation: 3n,
        doc: targetDocument,
      })),
    });
    await expect(
      createDocumentMutationPolicy(port).mutate({
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
      readFrozenReplicationSource: vi.fn(async () => frozenSource(source)),
    });
    const mutationPolicy = createDocumentMutationPolicy(port);
    const writer = await mutationPolicy.mutate({
      kind: "attributedFreshAuthorship",
      source: { kind: "writer" },
      update: updateWith("writer"),
    });
    const agent = await mutationPolicy.mutate({
      kind: "certifiedSemanticMutation",
      actor: "agent",
      ir: fullReplacementIr(),
    });
    const replication = await mutationPolicy.mutate({
      kind: "identityReplication",
      sourceCutId: "cut-1",
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
      readFrozenReplicationSource: vi.fn(async () => frozenSource(source, ++read === 1 ? 1n : 2n)),
    });
    await expect(
      createDocumentMutationPolicy(port).mutate({
        kind: "identityReplication",
        sourceCutId: "cut-1",
        plan: { kind: "wholeDocument" },
      }),
    ).rejects.toMatchObject({ code: "stale_replication_source" });
    expect(port.admitImmediate).not.toHaveBeenCalled();
  });

  it("rejects a frozen replication source from another document before replication", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "same client clocks, wrong document");
    const port = fakePort({
      readFrozenReplicationSource: vi.fn(async () => frozenSource(source, 3n, "doc-2")),
    });

    await expect(
      createDocumentMutationPolicy(port).mutate({
        kind: "identityReplication",
        sourceCutId: "cut-1",
        plan: { kind: "wholeDocument" },
      }),
    ).rejects.toMatchObject({
      code: "stale_replication_source",
      message: "Frozen replication source belongs to a different document",
    });
    expect(port.admitImmediate).not.toHaveBeenCalled();
  });

  it("rejects non-injective identity replication before journal or target apply", async () => {
    const base = proseDoc("a");
    const root = textRange(base);
    const target = cloneDoc(base);
    const source = cloneDoc(base);
    carryToRoot(target, root, "t");
    carryToRoot(source, root, "s");
    const beforeTarget = Y.encodeStateAsUpdate(target);
    const port = fakePort({
      readMutationTarget: vi.fn(async () => ({
        documentId: "target",
        generation: 1n,
        doc: target,
      })),
      readFrozenReplicationSource: vi.fn(async () => frozenSource(source, 1n, "target")),
    });

    await expect(
      createDocumentMutationPolicy(port).mutate({
        kind: "identityReplication",
        sourceCutId: "cut-1",
        plan: { kind: "wholeDocument" },
      }),
    ).rejects.toThrow("One provenance root unit cannot have two visible targets");
    expect(port.admitImmediate).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(target)).toEqual(beforeTarget);
  });

  it("rejects staged reserved-fact smuggling before persistence", async () => {
    const target = proseDoc("a");
    const hostile = cloneDoc(target);
    hostile.getArray(PROVENANCE_ROOTS_TYPE).push([{ invalid: true }]);
    const port = fakePort({
      readMutationTarget: vi.fn(async () => ({
        documentId: "target",
        generation: 3n,
        doc: target,
      })),
    });

    await expect(
      createDocumentMutationPolicy(port).stagePush({
        update: Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(target)),
        expectedGeneration: 3n,
      }),
    ).rejects.toThrow("Invalid root policy fact");
    expect(port.stagePush).not.toHaveBeenCalled();
    expect(target.getArray(PROVENANCE_ROOTS_TYPE).length).toBe(0);
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
      createDocumentMutationPolicy(port).mutate({
        kind: "authorityHeadSnapshotReplacement",
        checkpointId: "checkpoint-1",
        replaceGeneration: true,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "authority_head_busy" }));
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
      createDocumentMutationPolicy(port).mutate({
        kind: "authorityHeadSnapshotReplacement",
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
      createDocumentMutationPolicy(port).mutate({
        kind: "authorityHeadSnapshotReplacement",
        checkpointId: "checkpoint-1",
        replaceGeneration: true,
      }),
    ).rejects.toBeInstanceOf(DocumentMutationPolicyError);
  });

  it("exposes staged push and same-generation completion fences", async () => {
    const port = fakePort();
    const mutationPolicy = createDocumentMutationPolicy(port);
    await expect(
      mutationPolicy.stagePush({ update: updateWith("push"), expectedGeneration: 3n }),
    ).resolves.toBe("push-1");
    await mutationPolicy.completePush({ stagedPushId: "push-1", expectedGeneration: 3n });
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
    readMutationTarget: vi.fn(async () => ({
      documentId: "target",
      generation: 1n,
      doc: target,
    })),
    readFrozenReplicationSource: vi.fn(async () => frozenSource(source, 1n, "target")),
    admitImmediate: vi.fn(async ({ update }) => {
      Y.applyUpdate(target, update);
      return { sequence: 1n, joined: 0 };
    }),
  });
  await createDocumentMutationPolicy(port).mutate({
    kind: "identityReplication",
    sourceCutId: "cut-1",
    plan,
  });
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
  const target = textRange(doc);
  appendProvenanceFacts(doc, { targets: [{ version: 1, target, root }] });
}
