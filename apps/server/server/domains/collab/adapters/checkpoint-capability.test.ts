/** Checkpoint persistence accepts adapter identity, not copied coverage or replay functions. */
import { expect, it } from "vitest";
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import { mintCheckpointCut, resolveCheckpointCut } from "./checkpoint-capability.js";

it("rejects a spread forgery at the type and runtime boundaries", () => {
  const cut = mintCheckpointCut({
    documentId: "document",
    authority: Object.freeze({ authorityId: "authority", generation: 1n }),
    upToSeq: 1,
    materializeState: async () => new Uint8Array([1]),
    validateInputs: async () => {},
  });
  // @ts-expect-error Spread loses the private nominal member.
  const forged: CapturedCheckpointCut = {
    ...cut,
    upToSeq: 99,
    materializeState: async () => new Uint8Array([99]),
  };
  expect(() => resolveCheckpointCut(forged)).toThrow("Unrecognized checkpoint capability");
  expect(resolveCheckpointCut(cut).upToSeq).toBe(1);
});
