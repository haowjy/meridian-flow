/** The sole policy boundary for admitting content-bearing mutations to a document authority. */

import {
  type RestorationCertificatePort,
  type SemanticEditIRV1,
  validateSemanticEditIRV1,
} from "@meridian/agent-edit";
import type { DocumentRevision } from "@meridian/contracts";
import * as Y from "yjs";
import { PROVENANCE_RESERVED_TYPES, validateClientUpdateAdmission } from "./provenance.js";

export type AuthorshipSource =
  | { kind: "writer" }
  | { kind: "import" | "seed"; policy: "writer_protected" | "agent" };

export type IdentityReplicationPlan =
  | { kind: "wholeDocument" }
  | { kind: "sharedTypes"; names: readonly string[] };

export type AuthorityCheckpoint = {
  checkpointId: string;
  state: Uint8Array;
  attributionManifest: unknown;
};

export type RestorationCertificate = RestorationCertificatePort;

export type DocumentMutation =
  | { kind: "attributedFreshAuthorship"; source: AuthorshipSource; update: Uint8Array }
  | {
      kind: "certifiedSemanticMutation";
      actor: "agent";
      ir: SemanticEditIRV1;
      reversal?: RestorationCertificate;
    }
  | {
      kind: "identityReplication";
      sourceAuthorityCutId: string;
      plan: IdentityReplicationPlan;
    }
  | {
      kind: "authoritySnapshotReplacement";
      checkpointId: string;
      replaceGeneration: true;
    };

export type ImmediateAdmission = {
  update: Uint8Array;
  attribution: AuthorshipSource | { kind: "agent" };
};

export type FrozenAuthorityCut = {
  cutId: string;
  authorityId: string;
  generation: bigint;
  doc: Y.Doc;
};

export type MutableAuthority = {
  documentId: string;
  generation: bigint;
  doc: Y.Doc;
};

export type DocumentAuthorityPort = {
  /** Runs under lockDocumentMutation and atomically journals, joins every unresolved
   * same-generation settlement (incrementing join_version), and records the new head. */
  admitImmediate(input: ImmediateAdmission): Promise<{ sequence: bigint; joined: number }>;
  readMutableAuthority(): Promise<MutableAuthority>;
  readFrozenCut(cutId: string): Promise<FrozenAuthorityCut | null>;
  readCurrentRevision(): Promise<DocumentRevision>;
  lowerCertifiedMutation(ir: SemanticEditIRV1): Promise<Uint8Array>;
  loadCheckpoint(checkpointId: string): Promise<AuthorityCheckpoint | null>;
  unresolvedSettlements(generation: bigint): Promise<number>;
  /** Installs state and manifest in a fresh generation in the same transaction as the fence. */
  replaceGeneration(checkpoint: AuthorityCheckpoint, expectedGeneration: bigint): Promise<bigint>;
  disconnectGeneration(generation: bigint): Promise<void>;
  stagePush(input: { update: Uint8Array; expectedGeneration: bigint }): Promise<string>;
  completePush(input: { stagedPushId: string; expectedGeneration: bigint }): Promise<void>;
};

export class DocumentAuthorityError extends Error {
  constructor(
    readonly code:
      | "invalid_mutation"
      | "stale_source_authority"
      | "authority_busy"
      | "checkpoint_incomplete",
    message: string,
  ) {
    super(message);
    this.name = "DocumentAuthorityError";
  }
}

export type DocumentAuthority = ReturnType<typeof createDocumentAuthority>;

/**
 * Owns strategy validation and update production. Persistence owns the transaction,
 * but never accepts producer-supplied replication or certified-mutation bytes.
 */
export function createDocumentAuthority(port: DocumentAuthorityPort) {
  return {
    async mutate(
      mutation: DocumentMutation,
    ): Promise<{ sequence?: bigint; joined?: number; generation?: bigint }> {
      switch (mutation.kind) {
        case "attributedFreshAuthorship":
          return admitFresh(port, mutation);
        case "certifiedSemanticMutation":
          return admitCertified(port, mutation);
        case "identityReplication":
          return admitReplication(port, mutation);
        case "authoritySnapshotReplacement":
          return replaceSnapshot(port, mutation);
      }
    },

    stagePush(input: { update: Uint8Array; expectedGeneration: bigint }): Promise<string> {
      assertNonEmptyUpdate(input.update);
      return port.stagePush(input);
    },

    completePush(input: { stagedPushId: string; expectedGeneration: bigint }): Promise<void> {
      if (!input.stagedPushId) invalid("A staged push id is required");
      return port.completePush(input);
    },
  };
}

async function admitFresh(
  port: DocumentAuthorityPort,
  mutation: Extract<DocumentMutation, { kind: "attributedFreshAuthorship" }>,
): Promise<{ sequence: bigint; joined: number }> {
  assertFreshSource(mutation.source);
  assertNonEmptyUpdate(mutation.update);
  const authority = await port.readMutableAuthority();
  const admission = validateClientUpdateAdmission(authority.doc, mutation.update);
  if (admission.reservedClientId !== null)
    invalid("Reserved server client IDs cannot author fresh prose");
  const admitted = await port.admitImmediate({
    update: mutation.update,
    attribution: mutation.source,
  });
  return { sequence: admitted.sequence, joined: admitted.joined };
}

async function admitCertified(
  port: DocumentAuthorityPort,
  mutation: Extract<DocumentMutation, { kind: "certifiedSemanticMutation" }>,
): Promise<{ sequence: bigint; joined: number }> {
  if (mutation.actor !== "agent") invalid("Certified semantic mutations require the agent actor");
  const authority = await port.readMutableAuthority();
  const revision = await port.readCurrentRevision();
  validateSemanticEditIRV1(mutation.ir, {
    expectedDocumentId: authority.documentId,
    expectedInputRevision: revision,
    restorationCertificates: mutation.reversal,
  });
  const update = await port.lowerCertifiedMutation(mutation.ir);
  assertNonEmptyUpdate(update);
  const admitted = await port.admitImmediate({ update, attribution: { kind: "agent" } });
  return { sequence: admitted.sequence, joined: admitted.joined };
}

async function admitReplication(
  port: DocumentAuthorityPort,
  mutation: Extract<DocumentMutation, { kind: "identityReplication" }>,
): Promise<{ sequence: bigint; joined: number }> {
  if (!mutation.sourceAuthorityCutId) invalid("Identity replication requires a source cut");
  validateReplicationPlan(mutation.plan);
  const source = await port.readFrozenCut(mutation.sourceAuthorityCutId);
  if (!source) {
    throw new DocumentAuthorityError(
      "stale_source_authority",
      "Source authority cut is unavailable",
    );
  }
  const target = await port.readMutableAuthority();
  const sourceAgain = await port.readFrozenCut(mutation.sourceAuthorityCutId);
  if (
    !sourceAgain ||
    sourceAgain.authorityId !== source.authorityId ||
    sourceAgain.generation !== source.generation
  ) {
    throw new DocumentAuthorityError(
      "stale_source_authority",
      "Source authority changed while replication was prepared",
    );
  }
  const update = replicationUpdate(source.doc, target.doc, mutation.plan);
  assertNonEmptyUpdate(update);
  const admitted = await port.admitImmediate({ update, attribution: { kind: "agent" } });
  return { sequence: admitted.sequence, joined: admitted.joined };
}

async function replaceSnapshot(
  port: DocumentAuthorityPort,
  mutation: Extract<DocumentMutation, { kind: "authoritySnapshotReplacement" }>,
): Promise<{ generation: bigint }> {
  if (mutation.replaceGeneration !== true) invalid("Snapshot replacement must replace generation");
  const checkpoint = await port.loadCheckpoint(mutation.checkpointId);
  if (!checkpoint) invalid("Checkpoint does not exist");
  if (!checkpoint.attributionManifest || checkpoint.state.byteLength === 0) {
    throw new DocumentAuthorityError(
      "checkpoint_incomplete",
      "Checkpoint state and retained attribution manifest are both required",
    );
  }
  const current = await port.readMutableAuthority();
  if ((await port.unresolvedSettlements(current.generation)) > 0) {
    throw new DocumentAuthorityError(
      "authority_busy",
      "Authority has unresolved old-generation settlements",
    );
  }
  // The port installs a new Y.Doc. Checkpoint bytes are deliberately never applied to current.doc.
  const generation = await port.replaceGeneration(checkpoint, current.generation);
  await port.disconnectGeneration(current.generation);
  return { generation };
}

function replicationUpdate(
  source: Y.Doc,
  target: Y.Doc,
  plan: IdentityReplicationPlan,
): Uint8Array {
  if (plan.kind === "wholeDocument") {
    return Y.encodeStateAsUpdate(source, Y.encodeStateVector(target));
  }
  // Yjs updates cannot be safely filtered after encoding. Build the planned authority from
  // named top-level types, then diff it against the target; canonical item identities remain
  // those from the frozen source cut because the source update is applied, not re-authored.
  const planned = new Y.Doc({ gc: false });
  for (const [name, type] of source.share) instantiateSharedType(planned, name, type);
  const full = Y.encodeStateAsUpdate(source);
  Y.applyUpdate(planned, full);
  const allowed = new Set([...plan.names, ...PROVENANCE_RESERVED_TYPES]);
  planned.transact(() => {
    for (const [name, type] of planned.share) {
      if (allowed.has(name)) continue;
      clearSharedType(type);
    }
  }, "meridian-identity-replication-plan");
  return Y.encodeStateAsUpdate(planned, Y.encodeStateVector(target));
}

function instantiateSharedType(doc: Y.Doc, name: string, type: unknown): void {
  if (type instanceof Y.Map) doc.getMap(name);
  else if (type instanceof Y.Text) doc.getText(name);
  else if (type instanceof Y.Array) doc.getArray(name);
  else if (type instanceof Y.XmlFragment) doc.getXmlFragment(name);
  else invalid("Replication encountered an unsupported shared type");
}

function clearSharedType(type: unknown): void {
  if (type instanceof Y.Map) {
    type.clear();
    return;
  }
  if (type instanceof Y.Text || type instanceof Y.Array || type instanceof Y.XmlFragment) {
    if (type.length > 0) type.delete(0, type.length);
    return;
  }
  invalid("Replication encountered an unsupported shared type");
}

function validateReplicationPlan(plan: IdentityReplicationPlan): void {
  if (plan.kind === "wholeDocument") return;
  if (plan.kind !== "sharedTypes" || plan.names.length === 0) invalid("Replication plan is empty");
  if (new Set(plan.names).size !== plan.names.length || plan.names.some((name) => !name)) {
    invalid("Replication shared type names must be unique and non-empty");
  }
}

function assertFreshSource(source: AuthorshipSource): void {
  if (source.kind === "writer") return;
  if (
    (source.kind !== "import" && source.kind !== "seed") ||
    (source.policy !== "writer_protected" && source.policy !== "agent")
  ) {
    invalid("Import and seed authorship require an explicit safety policy");
  }
}

function assertNonEmptyUpdate(update: Uint8Array): void {
  if (!(update instanceof Uint8Array) || update.byteLength === 0)
    invalid("Mutation update is empty");
}

function invalid(message: string): never {
  throw new DocumentAuthorityError("invalid_mutation", message);
}
