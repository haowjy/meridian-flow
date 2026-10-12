/** Identity-backed checkpoint payloads shared by the trusted persistence adapters. */
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import type { CheckpointAuthority } from "../domain/ports/checkpoint-authority.js";

type CheckpointPayload = {
  readonly documentId: string;
  readonly authority: Readonly<CheckpointAuthority>;
  readonly upToSeq: number;
  materializeState(): Promise<Uint8Array>;
  validateInputs(): Promise<void>;
};

const payloads = new WeakMap<CapturedCheckpointCut, CheckpointPayload>();

export function mintCheckpointCut(payload: CheckpointPayload): CapturedCheckpointCut {
  const cut = Object.freeze({
    documentId: payload.documentId,
    authority: payload.authority,
    upToSeq: payload.upToSeq,
    materializeState: () => payload.materializeState(),
  }) as CapturedCheckpointCut;
  payloads.set(cut, Object.freeze(payload));
  return cut;
}

export function resolveCheckpointCut(cut: CapturedCheckpointCut): CheckpointPayload {
  const payload = payloads.get(cut);
  if (!payload) throw new Error("Unrecognized checkpoint capability");
  return payload;
}
