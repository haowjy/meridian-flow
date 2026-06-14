/**
 * Purpose: Verifies CheckpointRequest round-trips through component content and typed reply parsing.
 */
import { describe, expect, it } from "vitest";
import {
  checkpointRequestFromAskUser,
  componentContentForCheckpoint,
  parseCheckpointReplyValue,
} from "./builders.js";

describe("checkpoint builders", () => {
  it("round-trips ask_user through CheckpointRequest and component content", () => {
    const request = checkpointRequestFromAskUser(
      {
        question: "Choose one",
        kind: "choice",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        recommended: "a",
        requiresHuman: false,
      },
      "checkpoint_choice",
    );

    const content = componentContentForCheckpoint(request, 120_000);
    expect(content).toMatchObject({
      kind: "choice",
      checkpoint: { id: "checkpoint_choice", timeoutMs: 120_000 },
      props: {
        question: "Choose one",
        recommended: "a",
        requiresHuman: false,
      },
    });

    const reply = parseCheckpointReplyValue(request.answerSchema, { value: "b" });
    expect(reply).toEqual({ value: "b" });
  });

  it("builds a generic checkpoint component for non ask_user schemas", () => {
    const request = {
      checkpointId: "checkpoint_generic",
      prompt: "Confirm threshold",
      artifacts: [{ type: "image" as const, url: "https://example.test/qc.png" }],
      answerSchema: {
        type: "object",
        properties: {
          threshold: { type: "number" },
        },
        required: ["threshold"],
      },
      requiresHuman: true,
    };

    const content = componentContentForCheckpoint(request, 60_000);
    expect(content).toMatchObject({
      kind: "checkpoint",
      checkpoint: { id: "checkpoint_generic", timeoutMs: 60_000 },
      props: {
        prompt: "Confirm threshold",
        requiresHuman: true,
      },
    });
  });
});
