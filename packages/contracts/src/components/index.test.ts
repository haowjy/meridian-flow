/**
 * Purpose: Verifies the shared ask_user prop contract and interrupt answer helpers that keep server builders and client renderers from drifting.
 */
import { describe, expect, it } from "vitest";

import {
  ASK_USER_TOOL_INPUT_SCHEMA,
  normalizeInterruptAnswerValue,
  parseAskUserToolInput,
} from "./index.js";

describe("normalizeInterruptAnswerValue", () => {
  it("unwraps exactly one interrupt answer envelope", () => {
    expect(normalizeInterruptAnswerValue("direct")).toBe("direct");
    expect(normalizeInterruptAnswerValue({ value: "wrapped" })).toBe("wrapped");
    expect(normalizeInterruptAnswerValue({ value: { value: "nested" } })).toBe(
      JSON.stringify({ value: "nested" }),
    );
  });
});

describe("ask_user component contract", () => {
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
