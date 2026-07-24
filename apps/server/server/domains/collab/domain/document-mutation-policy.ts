/** The sole policy boundary for admitting content-bearing document mutations. */

import {
  type RestorationCertificatePort,
  type SemanticEditIRV1,
  validateSemanticEditIRV1,
} from "@meridian/agent-edit";
import type { DocumentRevision } from "@meridian/contracts";
import * as Y from "yjs";
import {
  PROVENANCE_RESERVED_TYPES,
  validateClientUpdateAdmission,
  validateProvenanceGraph,
} from "./provenance.js";

export type AuthorshipSource =
  | { kind: "writer" }
  | { kind: "import" | "seed"; policy: "writer_protected" | "agent" };

export type IdentityReplicationPlan =
  | { kind: "wholeDocument" }
  | { kind: "sharedTypes"; names: readonly string[] };

export type AuthorityHeadCheckpoint = {
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
      sourceCutId: string;
      plan: IdentityReplicationPlan;
    }
  | {
      kind: "authorityHeadSnapshotReplacement";
      checkpointId: string;
      replaceGeneration: true;
    };

export type ImmediateAdmission = {
  update: Uint8Array;
  attribution: AuthorshipSource | { kind: "agent" };
};

export class ReservedWriterClientIdError extends Error {
  constructor(readonly clientId: number) {
    super("Reserved server client IDs cannot author fresh prose");
    this.name = "ReservedWriterClientIdError";
  }
}

export type FrozenReplicationSource = {
  cutId: string;
  documentId: string;
  sourceId: string;
  version: bigint;
  doc: Y.Doc;
};

export type MutationTarget = {
  documentId: string;
  generation: bigint;
  doc: Y.Doc;
};

export type DocumentMutationPolicyPort = {
  /** Runs under lockDocumentMutation and atomically journals, joins every unresolved
   * same-generation settlement (incrementing join_version), and records the new head. */
  admitImmediate(input: ImmediateAdmission): Promise<{ sequence: bigint; joined: number }>;
  readMutationTarget(): MutationTarget | Promise<MutationTarget>;
  readFrozenReplicationSource(cutId: string): Promise<FrozenReplicationSource | null>;
  readCurrentRevision(): Promise<DocumentRevision>;
  lowerCertifiedMutation(ir: SemanticEditIRV1): Promise<Uint8Array>;
  loadCheckpoint(checkpointId: string): Promise<AuthorityHeadCheckpoint | null>;
  unresolvedSettlements(generation: bigint): Promise<number>;
  /** Installs state and manifest in a fresh generation in the same transaction as the fence. */
  replaceGeneration(
    checkpoint: AuthorityHeadCheckpoint,
    expectedGeneration: bigint,
  ): Promise<bigint>;
  disconnectGeneration(generation: bigint): Promise<void>;
  stagePush(input: { update: Uint8Array; expectedGeneration: bigint }): Promise<string>;
  completePush(input: { stagedPushId: string; expectedGeneration: bigint }): Promise<void>;
};

export class DocumentMutationPolicyError extends Error {
  constructor(
    readonly code:
      | "invalid_mutation"
      | "stale_target_generation"
      | "stale_replication_source"
      | "authority_head_busy"
      | "checkpoint_incomplete",
    message: string,
  ) {
    super(message);
    this.name = "DocumentMutationPolicyError";
  }
}

export type DocumentMutationPolicy = ReturnType<typeof createDocumentMutationPolicy>;

/** Shared target validation → containment → authorship → append sequence for writer frames. */
export async function admitWriterUpdate<T>(input: {
  targetDocument: Y.Doc;
  update: Uint8Array;
  validateTarget(): void | Promise<void>;
  isContained(): boolean;
  append(): Promise<T>;
}): Promise<{ admitted: false } | { admitted: true; value: T }> {
  const validation = input.validateTarget();
  if (validation) await validation;
  if (input.isContained()) return { admitted: false };
  const admission = validateFreshAuthorship(input.targetDocument, input.update, { kind: "writer" });
  if (admission.reservedClientId !== null) {
    throw new ReservedWriterClientIdError(admission.reservedClientId);
  }
  return { admitted: true, value: await input.append() };
}

/**
 * Owns strategy validation and update production. Persistence owns the transaction,
 * but never accepts producer-supplied replication or certified-mutation bytes.
 */
export function createDocumentMutationPolicy(port: DocumentMutationPolicyPort) {
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
        case "authorityHeadSnapshotReplacement":
          return replaceSnapshot(port, mutation);
      }
    },

    async stagePush(input: { update: Uint8Array; expectedGeneration: bigint }): Promise<string> {
      assertNonEmptyUpdate(input.update);
      const target = await port.readMutationTarget();
      if (target.generation !== input.expectedGeneration) {
        throw new DocumentMutationPolicyError(
          "stale_target_generation",
          "Durable authority head generation changed before push staging",
        );
      }
      validatePostUpdateProvenance(target.doc, input.update);
      return port.stagePush(input);
    },

    completePush(input: { stagedPushId: string; expectedGeneration: bigint }): Promise<void> {
      if (!input.stagedPushId) invalid("A staged push id is required");
      return port.completePush(input);
    },
  };
}

async function admitFresh(
  port: DocumentMutationPolicyPort,
  mutation: Extract<DocumentMutation, { kind: "attributedFreshAuthorship" }>,
): Promise<{ sequence: bigint; joined: number }> {
  const targetValue = port.readMutationTarget();
  const target = isPromise(targetValue) ? await targetValue : targetValue;
  const admission = validateFreshAuthorship(target.doc, mutation.update, mutation.source);
  if (admission.reservedClientId !== null)
    invalid("Reserved server client IDs cannot author fresh prose");
  const admitted = await port.admitImmediate({
    update: mutation.update,
    attribution: mutation.source,
  });
  return { sequence: admitted.sequence, joined: admitted.joined };
}

function validateFreshAuthorship(
  targetDocument: Y.Doc,
  update: Uint8Array,
  source: AuthorshipSource,
): ReturnType<typeof validateClientUpdateAdmission> {
  assertFreshSource(source);
  assertNonEmptyUpdate(update);
  let admission: ReturnType<typeof validateClientUpdateAdmission>;
  try {
    admission = validateClientUpdateAdmission(targetDocument, update);
  } catch (cause) {
    invalid(
      cause instanceof Error
        ? cause.message
        : "Document mutation policy could not validate the client update",
    );
  }
  return admission;
}

async function admitCertified(
  port: DocumentMutationPolicyPort,
  mutation: Extract<DocumentMutation, { kind: "certifiedSemanticMutation" }>,
): Promise<{ sequence: bigint; joined: number }> {
  if (mutation.actor !== "agent") invalid("Certified semantic mutations require the agent actor");
  const target = await port.readMutationTarget();
  const revision = await port.readCurrentRevision();
  validateSemanticEditIRV1(mutation.ir, {
    expectedDocumentId: target.documentId,
    expectedInputRevision: revision,
    restorationCertificates: mutation.reversal,
  });
  const update = await port.lowerCertifiedMutation(mutation.ir);
  assertNonEmptyUpdate(update);
  const admitted = await port.admitImmediate({ update, attribution: { kind: "agent" } });
  return { sequence: admitted.sequence, joined: admitted.joined };
}

async function admitReplication(
  port: DocumentMutationPolicyPort,
  mutation: Extract<DocumentMutation, { kind: "identityReplication" }>,
): Promise<{ sequence: bigint; joined: number }> {
  if (!mutation.sourceCutId) invalid("Identity replication requires a source cut");
  validateReplicationPlan(mutation.plan);
  const source = await port.readFrozenReplicationSource(mutation.sourceCutId);
  if (!source) {
    throw new DocumentMutationPolicyError(
      "stale_replication_source",
      "Frozen replication source is unavailable",
    );
  }
  const target = await port.readMutationTarget();
  if (source.documentId !== target.documentId) {
    throw new DocumentMutationPolicyError(
      "stale_replication_source",
      "Frozen replication source belongs to a different document",
    );
  }
  const sourceAgain = await port.readFrozenReplicationSource(mutation.sourceCutId);
  if (
    !sourceAgain ||
    sourceAgain.documentId !== source.documentId ||
    sourceAgain.sourceId !== source.sourceId ||
    sourceAgain.version !== source.version
  ) {
    throw new DocumentMutationPolicyError(
      "stale_replication_source",
      "Frozen replication source changed while replication was prepared",
    );
  }
  const update = replicationUpdate(source.doc, target.doc, mutation.plan);
  assertNonEmptyUpdate(update);
  validatePostUpdateProvenance(target.doc, update);
  const admitted = await port.admitImmediate({ update, attribution: { kind: "agent" } });
  return { sequence: admitted.sequence, joined: admitted.joined };
}

function validatePostUpdateProvenance(targetDocument: Y.Doc, update: Uint8Array): void {
  const candidate = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(targetDocument));
    Y.applyUpdate(candidate, update);
    validateProvenanceGraph(candidate);
  } catch (cause) {
    invalid(cause instanceof Error ? cause.message : "Candidate provenance graph is invalid");
  } finally {
    candidate.destroy();
  }
}

async function replaceSnapshot(
  port: DocumentMutationPolicyPort,
  mutation: Extract<DocumentMutation, { kind: "authorityHeadSnapshotReplacement" }>,
): Promise<{ generation: bigint }> {
  if (mutation.replaceGeneration !== true) invalid("Snapshot replacement must replace generation");
  const checkpoint = await port.loadCheckpoint(mutation.checkpointId);
  if (!checkpoint) invalid("Checkpoint does not exist");
  if (!checkpoint.attributionManifest || checkpoint.state.byteLength === 0) {
    throw new DocumentMutationPolicyError(
      "checkpoint_incomplete",
      "Durable checkpoint state and retained attribution manifest are both required",
    );
  }
  const current = await port.readMutationTarget();
  if ((await port.unresolvedSettlements(current.generation)) > 0) {
    throw new DocumentMutationPolicyError(
      "authority_head_busy",
      "Durable authority head has unresolved old-generation settlements",
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
  // Yjs updates cannot be safely filtered after encoding. Build the planned document from
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

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function";
}

function invalid(message: string): never {
  throw new DocumentMutationPolicyError(
    "invalid_mutation",
    `Document mutation policy rejected mutation: ${message}`,
  );
}
