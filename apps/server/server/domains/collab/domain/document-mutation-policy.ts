import * as Y from "yjs";
import { createDocumentContainment } from "./document-containment.js";

export type AuthorityHeadCheckpoint = {
  checkpointId: string;
  state: Uint8Array;
  attributionManifest: unknown;
};

export type MutationTarget = {
  documentId: string;
  generation: bigint;
  doc: Y.Doc;
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
    if (from > held) throw new WriterFrameGapError(client, from, held);
    if (from < held) overlaps = true;
  }
  return overlaps ? Y.diffUpdate(update, stateVector) : update;
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

function invalid(message: string): never {
  throw new DocumentMutationPolicyError(
    "invalid_mutation",
    `Document mutation policy rejected mutation: ${message}`,
  );
}
