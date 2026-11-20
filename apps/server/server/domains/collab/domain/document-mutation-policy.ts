import * as Y from "yjs";
import { createDocumentContainment } from "./document-containment.js";

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

export type MutationTarget = {
  documentId: string;
  generation: bigint;
  doc: Y.Doc;
};

export type FreshAuthorshipPort = {
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
  constructor() {
    super("writer-frame-gap");
    this.name = "WriterFrameGapError";
  }
}

const roomContainment = createDocumentContainment();

/**
 * What of a writer's frame the room lacks, or null when it holds all of it (a reconnect's
 * replay). Throws on a frame that starts past the room's clock for one of its clients: no later
 * read could integrate it, so the socket closes and the reconnect's handshake carries the prefix.
 */
export function novelToRoom(room: Y.Doc, update: Uint8Array): Uint8Array | null {
  if (roomContainment.contains(room, update)) return null;
  const stateVector = Y.encodeStateVector(room);
  const clocks = Y.decodeStateVector(stateVector);
  let overlaps = false;
  for (const [client, from] of Y.parseUpdateMeta(update).from) {
    const held = clocks.get(client) ?? 0;
    if (from > held) throw new WriterFrameGapError();
    if (from < held) overlaps = true;
  }
  return overlaps ? Y.diffUpdate(update, stateVector) : update;
}

/** Validates and admits one fresh writer, import, or seed update. */
export async function admitFreshAuthorship(
  port: FreshAuthorshipPort,
  mutation: { source: AuthorshipSource; update: Uint8Array },
): Promise<{ sequence: bigint }> {
  assertFreshSource(mutation.source);
  assertNonEmptyUpdate(mutation.update);
  const admitted = await port.admitImmediate({
    update: mutation.update,
    attribution: mutation.source,
  });
  return { sequence: admitted.sequence };
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

function invalid(message: string): never {
  throw new DocumentMutationPolicyError(
    "invalid_mutation",
    `Document mutation policy rejected mutation: ${message}`,
  );
}
