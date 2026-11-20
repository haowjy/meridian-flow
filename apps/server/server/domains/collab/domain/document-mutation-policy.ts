import * as Y from "yjs";
import { createDocumentContainment } from "./document-containment.js";
import { validateClientUpdateAdmission } from "./provenance.js";

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
  /** Journals under the document mutation lock and records the new authority head. */
  admitImmediate(input: ImmediateAdmission): Promise<{ sequence: bigint }>;
};

export type AuthorityGenerationReplacementPort = {
  readMutationTarget(): MutationTarget | Promise<MutationTarget>;
  loadCheckpoint(checkpointId: string): Promise<AuthorityHeadCheckpoint | null>;
  /** Installs state and manifest in a fresh generation in the same transaction as the fence. */
  replaceGeneration(
    checkpoint: AuthorityHeadCheckpoint,
    expectedGeneration: bigint,
  ): Promise<bigint>;
  disconnectGeneration(generation: bigint): Promise<void>;
};

export class DocumentMutationPolicyError extends Error {
  constructor(
    readonly code: "invalid_mutation" | "checkpoint_incomplete",
    message: string,
  ) {
    super(message);
    this.name = "DocumentMutationPolicyError";
  }
}

export type AuthorityGenerationReplacement = (
  checkpointId: string,
) => Promise<{ generation: bigint }>;

export class WriterFrameGapError extends Error {
  constructor(client: number, from: number, held: number) {
    super(`writer-frame-gap: client ${client} starts at clock ${from}, the room holds ${held}`);
    this.name = "WriterFrameGapError";
  }
}

const roomContainment = createDocumentContainment();

/**
 * What of a writer's frame the room lacks, or null when it holds all of it (a reconnect's
 * replay). Throws on reserved authorship, and on a frame that starts past the room's clock for
 * one of its clients: no later read could integrate it, so the socket closes and the
 * reconnect's handshake carries the prefix.
 */
export function novelToRoom(room: Y.Doc, update: Uint8Array): Uint8Array | null {
  if (roomContainment.contains(room, update)) return null;
  assertWriterAuthorship(room, update);
  const stateVector = Y.encodeStateVector(room);
  const clocks = Y.decodeStateVector(stateVector);
  let overlaps = false;
  for (const [client, from] of Y.parseUpdateMeta(update).from) {
    const held = clocks.get(client) ?? 0;
    if (from > held) throw new WriterFrameGapError(client, from, held);
    if (from < held) overlaps = true;
  }
  return overlaps ? Y.diffUpdate(update, stateVector) : update;
}

/**
 * A writer update's authorship against `targetDocument`'s reserved namespace: a reserved
 * client id or a reserved delete target throws.
 */
function assertWriterAuthorship(targetDocument: Y.Doc, update: Uint8Array): void {
  // Reconnect snapshots include server-owned structs the prefix already holds. They
  // author nothing twice; only novel structs and the incoming delete set need admission.
  const novel = Y.diffUpdate(update, Y.encodeStateVector(targetDocument));
  const admission = validateFreshAuthorship(targetDocument, novel, { kind: "writer" });
  if (admission.reservedClientId !== null) {
    throw new ReservedWriterClientIdError(admission.reservedClientId);
  }
}

/** Validates and admits one fresh writer, import, or seed update. */
export async function admitFreshAuthorship(
  port: FreshAuthorshipPort,
  mutation: { source: AuthorshipSource; update: Uint8Array },
): Promise<{ sequence: bigint }> {
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
  return { sequence: admitted.sequence };
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
