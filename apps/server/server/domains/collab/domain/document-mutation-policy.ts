/** The sole policy boundary for admitting content-bearing document mutations. */

import { validateSemanticEditIRV1 } from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { AppendBranchJournalInput } from "./branch-store.js";
import { validateClientUpdateAdmission, validateProvenanceGraph } from "./provenance.js";

export type AuthorshipSource =
  | { kind: "writer" }
  | { kind: "import" | "seed"; policy: "writer_protected" | "agent" };

export type AuthorityHeadCheckpoint = {
  checkpointId: string;
  state: Uint8Array;
  attributionManifest: unknown;
};

type ImmediateAdmission = {
  update: Uint8Array;
  attribution: AuthorshipSource | { kind: "agent" };
};

export class ReservedWriterClientIdError extends Error {
  constructor(readonly clientId: number) {
    super("Reserved server client IDs cannot author fresh prose");
    this.name = "ReservedWriterClientIdError";
  }
}

export type MutationTarget = {
  documentId: string;
  generation: bigint;
  doc: Y.Doc;
};

export type FreshAuthorshipPort = {
  readMutationTarget(): MutationTarget | Promise<MutationTarget>;
  /** Runs under lockDocumentMutation and atomically journals, joins every unresolved
   * same-generation settlement (incrementing join_version), and records the new head. */
  admitImmediate(input: ImmediateAdmission): Promise<{ sequence: bigint; joined: number }>;
};

export type AuthorityGenerationReplacementPort = {
  readMutationTarget(): MutationTarget | Promise<MutationTarget>;
  loadCheckpoint(checkpointId: string): Promise<AuthorityHeadCheckpoint | null>;
  unresolvedSettlements(generation: bigint): Promise<number>;
  /** Installs state and manifest in a fresh generation in the same transaction as the fence. */
  replaceGeneration(
    checkpoint: AuthorityHeadCheckpoint,
    expectedGeneration: bigint,
  ): Promise<bigint>;
  disconnectGeneration(generation: bigint): Promise<void>;
};

export class DocumentMutationPolicyError extends Error {
  constructor(
    readonly code: "invalid_mutation" | "authority_head_busy" | "checkpoint_incomplete",
    message: string,
  ) {
    super(message);
    this.name = "DocumentMutationPolicyError";
  }
}

export type AuthorityGenerationReplacement = (
  checkpointId: string,
) => Promise<{ generation: bigint }>;

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
  assertWriterAuthorship(input.targetDocument, input.update);
  return { admitted: true, value: await input.append() };
}

/**
 * A writer update's authorship against `targetDocument`'s reserved namespace: a reserved
 * client id or a reserved delete target throws. A frame's early rejection judges its base
 * replica; finalization judges the committed prefix again when that moved (design §2.2).
 */
export function assertWriterAuthorship(targetDocument: Y.Doc, update: Uint8Array): void {
  const admission = validateFreshAuthorship(targetDocument, update, { kind: "writer" });
  if (admission.reservedClientId !== null) {
    throw new ReservedWriterClientIdError(admission.reservedClientId);
  }
}

/** Validates and admits one fresh writer, import, or seed update. */
export async function admitFreshAuthorship(
  port: FreshAuthorshipPort,
  mutation: { source: AuthorshipSource; update: Uint8Array },
): Promise<{ sequence: bigint; joined: number }> {
  const targetValue = port.readMutationTarget();
  const target = isPromise(targetValue) ? await targetValue : targetValue;
  const admission = validateFreshAuthorship(target.doc, mutation.update, mutation.source);
  if (admission.reservedClientId !== null) {
    invalid("Reserved server client IDs cannot author fresh prose");
  }
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

/**
 * `source` replicated whole into `target` from a frozen copy: the identity replication every
 * branch seed, pull and reset uses. The candidate's provenance is validated before `target`
 * changes; persistence belongs to the branch store.
 */
export function replicateFrozenSource(source: Y.Doc, target: Y.Doc): void {
  const update = Y.encodeStateAsUpdate(source, Y.encodeStateVector(target));
  assertNonEmptyUpdate(update);
  validatePostUpdateProvenance(target, update);
  Y.applyUpdate(target, update);
}

/**
 * A branch's journal rows applied to `doc`, validated per logical write: the rows of one
 * semantic edit against its IR (document and input revision) before any of them applies,
 * each other row on its own.
 */
export function admitSegmentRows(
  doc: Y.Doc,
  documentId: string,
  journals: readonly AppendBranchJournalInput[],
): void {
  for (let index = 0; index < journals.length; ) {
    const first = journals[index];
    const writeRows = [first];
    index++;
    while (
      index < journals.length &&
      first.semanticEditIr &&
      journals[index].semanticEditIr === first.semanticEditIr
    )
      writeRows.push(journals[index++]);
    if (first.semanticEditIr) {
      validateSemanticEditIRV1(first.semanticEditIr, {
        expectedDocumentId: documentId,
        expectedInputRevision: first.semanticEditIr.inputRevision,
      });
      for (const row of writeRows) assertNonEmptyUpdate(row.updateData);
    }
    for (const row of writeRows) {
      if (row.source === "agent") assertFreshAgentUpdate(doc, row.updateData);
      Y.applyUpdate(doc, row.updateData);
    }
  }
}

/**
 * The admitted rows hold everything `source` wrote: `source`'s difference from `admitted`,
 * applied to a copy of it, must change nothing and leave no unresolved structs or deletes (a
 * source includes the target's complete causal prefix, so a dependency it lacks is a residual
 * the rows never journaled). Throws on a residual; `admitted` itself is never touched.
 */
export function assertSegmentRowsComplete(source: Y.Doc, admitted: Y.Doc): void {
  const probe = createCollabYDoc({ gc: false });
  let changed = false;
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(admitted));
    probe.on("update", () => {
      changed = true;
    });
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(source, Y.encodeStateVector(admitted)));
    if (probe.store.pendingStructs || probe.store.pendingDs)
      throw new Error("Branch sync delta has unresolved Yjs dependencies");
    if (changed) throw new Error("Segment write left an unjournaled residual");
  } finally {
    probe.destroy();
  }
}

/** Draft agent rows own fresh structs; deletes may refer to older clients. */
export function assertFreshAgentUpdate(doc: Y.Doc, update: Uint8Array): void {
  const clients = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const struct of Y.decodeUpdate(update).structs) {
    if (clients.has(struct.id.client))
      throw new Error(`Agent segment reused client ${struct.id.client}`);
  }
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

/** Replaces the durable authority generation from one complete checkpoint. */
export async function replaceAuthorityGeneration(
  port: AuthorityGenerationReplacementPort,
  checkpointId: string,
): Promise<{ generation: bigint }> {
  const checkpoint = await port.loadCheckpoint(checkpointId);
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
  if (!(update instanceof Uint8Array) || update.byteLength === 0) {
    invalid("Mutation update is empty");
  }
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
