/**
 * Purpose: Verifies the shared ask_user prop contract and checkpoint answer helpers that keep server builders and client renderers from drifting.
 */
import { describe, expect, it } from "vitest";

import {
  ASK_USER_TOOL_INPUT_SCHEMA,
  buildAskUserComponentContent,
  checkpointResolvedPropsFromAnswer,
  normalizeCheckpointAnswerValue,
  parseAskUserToolInput,
} from "./index.js";

describe("normalizeCheckpointAnswerValue", () => {
  it("unwraps exactly one checkpoint answer envelope", () => {
    expect(normalizeCheckpointAnswerValue("direct")).toBe("direct");
    expect(normalizeCheckpointAnswerValue({ value: "wrapped" })).toBe("wrapped");
    expect(normalizeCheckpointAnswerValue({ value: { value: "nested" } })).toBe(
      JSON.stringify({ value: "nested" }),
    );
  });
});

describe("ask_user component contract", () => {
  it("builds JSON-natural choice/free-text component props from one typed surface", () => {
    const choice = buildAskUserComponentContent({
      checkpointId: "checkpoint_choice",
      kind: "choice",
      question: "Which analysis?",
      options: [{ value: "quick", label: "Quick" }],
      recommended: "quick",
      requiresHuman: false,
      timeoutMs: 270_000,
    });
    const freeText = buildAskUserComponentContent({
      checkpointId: "checkpoint_text",
      kind: "free-text",
      question: "What label?",
      recommended: null,
      requiresHuman: true,
      timeoutMs: 270_000,
    });

    expect(JSON.parse(JSON.stringify(choice))).toEqual(choice);
    expect(choice).toMatchObject({
      kind: "choice",
      props: {
        question: "Which analysis?",
        options: [{ value: "quick", label: "Quick" }],
        recommended: "quick",
        requiresHuman: false,
      },
      checkpoint: { id: "checkpoint_choice", timeoutMs: 270_000 },
    });
    expect(freeText).toMatchObject({
      kind: "free-text",
      props: {
        question: "What label?",
        recommended: null,
        requiresHuman: true,
      },
    });
  });

  it("parses the server tool input and shares the kind enum with the JSON schema", () => {
    expect(ASK_USER_TOOL_INPUT_SCHEMA.properties.kind.enum).toEqual(["choice", "free-text"]);
    expect(
      parseAskUserToolInput({
        question: "Proceed?",
        kind: "choice",
        options: [{ value: "yes", label: "Yes" }],
        recommended: null,
        requiresHuman: true,
        timeoutMs: 12.9,
      }),
    ).toEqual({
      ok: true,
      value: {
        question: "Proceed?",
        kind: "choice",
        options: [{ value: "yes", label: "Yes" }],
        recommended: null,
        requiresHuman: true,
        timeoutMs: 12,
      },
    });
  });
});

describe("checkpointResolvedPropsFromAnswer", () => {
  it("normalizes the resolved patch shape applied to component props", () => {
    expect(
      checkpointResolvedPropsFromAnswer({ value: { value: "quick" }, provenance: "user" }),
    ).toEqual({
      resolvedValue: "quick",
      answerProvenance: "user",
    });
  });
});
