/** Operation-specific contract tests for document mutation admission policy. */

import type { DocumentRevision } from "@meridian/contracts";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  type AuthorityGenerationReplacementPort,
  admitCertifiedMutation,
  admitFreshAuthorship,
  DocumentMutationPolicyError,
  type FreshAuthorshipPort,
  type FrozenReplicationSource,
  type MutationTarget,
  replaceAuthorityGeneration,
  replicateFrozenIdentity,
} from "./document-mutation-policy.js";
import { appendProvenanceFacts } from "./provenance.js";

const revision = "revision-1" as DocumentRevision;

function updateWith(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.getText("prosemirror").insert(0, value);
  return Y.encodeStateAsUpdate(doc);
}

function freshPort(
  doc = new Y.Doc({ gc: false }),
  overrides: Partial<FreshAuthorshipPort> = {},
): FreshAuthorshipPort {
  return {
    admitImmediate: vi.fn(async () => ({ sequence: 4n, joined: 2 })),
    readMutationTarget: vi.fn(() => ({ documentId: "doc-1", generation: 3n, doc })),
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

describe("document mutation policy operations", () => {
  it("admits fresh writer authorship with exact attribution", async () => {
    const port = freshPort();
    const update = updateWith("restored");

    await admitFreshAuthorship(port, { source: { kind: "writer" }, update });

    expect(port.admitImmediate).toHaveBeenCalledWith({
      update,
      attribution: { kind: "writer" },
    });
  });

  it("requires explicit import and seed policy", async () => {
    const port = freshPort();
    await expect(
      admitFreshAuthorship(port, {
        source: { kind: "import", policy: "unknown" } as never,
        update: updateWith("import"),
      }),
    ).rejects.toMatchObject({ code: "invalid_mutation" });
    expect(port.admitImmediate).not.toHaveBeenCalled();
  });

  it("validates semantic intent before lowering and admission", async () => {
    const target = new Y.Doc({ gc: false });
    const lowerCertifiedMutation = vi.fn(async () => updateWith("agent"));
    const admitImmediate = vi.fn(async () => ({ sequence: 4n, joined: 2 }));
    const ir = fullReplacementIr();

    await admitCertifiedMutation(
      {
        readMutationTarget: async () => ({
          documentId: "doc-1",
          generation: 3n,
          doc: target,
        }),
        readCurrentRevision: async () => revision,
        lowerCertifiedMutation,
        admitImmediate,
      },
      { ir },
    );

    expect(lowerCertifiedMutation).toHaveBeenCalledWith(ir);
    expect(admitImmediate).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: { kind: "agent" } }),
    );
  });

  it("computes identity replication bytes from a directly supplied frozen source", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "source");
    const target = new Y.Doc({ gc: false });
    const admit = vi.fn(async ({ update }: { update: Uint8Array }) => {
      Y.applyUpdate(target, update);
      return { sequence: 1n, joined: 0 };
    });

    await replicateFrozenIdentity({
      source: frozenSource(source),
      target: mutationTarget(target),
      plan: { kind: "wholeDocument" },
      admit,
    });

    expect(target.getText("prosemirror").toString()).toBe("source");
  });

  it("selectively replicates named shared types and carries delete-only state", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "kept");
    source.getText("companion").insert(0, "excluded");
    source.getText("deleted").insert(0, "gone");
    source.getText("deleted").delete(0, 4);
    const target = new Y.Doc({ gc: false });

    await replicateInto(source, target, { kind: "sharedTypes", names: ["prosemirror"] });

    expect(target.getText("prosemirror").toString()).toBe("kept");
    expect(target.getText("companion").toString()).toBe("");
    expect(target.getText("deleted").toString()).toBe("");
  });

  it("rejects a frozen replication source from another document", async () => {
    const source = new Y.Doc({ gc: false });
    source.getText("prosemirror").insert(0, "wrong document");
    const admit = vi.fn();

    await expect(
      replicateFrozenIdentity({
        source: { documentId: "doc-2", doc: source },
        target: mutationTarget(new Y.Doc({ gc: false })),
        plan: { kind: "wholeDocument" },
        admit,
      }),
    ).rejects.toMatchObject({
      code: "invalid_mutation",
      message: expect.stringContaining("different document"),
    });
    expect(admit).not.toHaveBeenCalled();
  });

  it("rejects non-injective identity replication before admission or target apply", async () => {
    const base = proseDoc("a");
    const root = textRange(base);
    const target = cloneDoc(base);
    const source = cloneDoc(base);
    carryToRoot(target, root, "t");
    carryToRoot(source, root, "s");
    const beforeTarget = Y.encodeStateAsUpdate(target);
    const admit = vi.fn();

    await expect(
      replicateFrozenIdentity({
        source: frozenSource(source, "target"),
        target: mutationTarget(target, "target"),
        plan: { kind: "wholeDocument" },
        admit,
      }),
    ).rejects.toThrow("One provenance root unit cannot have two visible targets");
    expect(admit).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(target)).toEqual(beforeTarget);
  });

  it("refuses replacement while old-generation settlement is unresolved", async () => {
    const port = replacementPort({ unresolvedSettlements: vi.fn(async () => 1) });

    await expect(replaceAuthorityGeneration(port, "checkpoint-1")).rejects.toEqual(
      expect.objectContaining({ code: "authority_head_busy" }),
    );
    expect(port.replaceGeneration).not.toHaveBeenCalled();
  });

  it("installs a complete checkpoint as a new generation and fences old clients", async () => {
    const port = replacementPort();

    await expect(replaceAuthorityGeneration(port, "checkpoint-1")).resolves.toEqual({
      generation: 4n,
    });
    expect(port.disconnectGeneration).toHaveBeenCalledWith(3n);
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
    unresolvedSettlements: vi.fn(async () => 0),
    replaceGeneration: vi.fn(async () => 4n),
    disconnectGeneration: vi.fn(async () => undefined),
    ...overrides,
  };
}

function frozenSource(doc: Y.Doc, documentId = "doc-1"): FrozenReplicationSource {
  return { documentId, doc };
}

function mutationTarget(doc: Y.Doc, documentId = "doc-1"): MutationTarget {
  return { documentId, generation: 1n, doc };
}

async function replicateInto(
  source: Y.Doc,
  target: Y.Doc,
  plan: { kind: "wholeDocument" } | { kind: "sharedTypes"; names: readonly string[] },
): Promise<void> {
  await replicateFrozenIdentity({
    source: frozenSource(source, "target"),
    target: mutationTarget(target, "target"),
    plan,
    admit: async ({ update }) => {
      Y.applyUpdate(target, update);
      return { sequence: 1n, joined: 0 };
    },
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
  appendProvenanceFacts(doc, { targets: [{ version: 1, target: textRange(doc), root }] });
}
