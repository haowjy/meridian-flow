/**
 * Purpose: Verifies the shared ask_user prop contract and interrupt answer helpers that keep server builders and client renderers from drifting.
 */
import { describe, expect, it } from "vitest";

import {
  ASK_USER_TOOL_INPUT_SCHEMA,
  buildAskUserComponentContent,
  interruptResolvedPropsFromAnswer,
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
  it("builds JSON-natural choice/free-text component props from one typed surface", () => {
    const choice = buildAskUserComponentContent({
      interruptId: "interrupt_choice",
      kind: "choice",
      question: "Which analysis?",
      options: [{ value: "quick", label: "Quick" }],
      recommended: "quick",
      requiresHuman: false,
      timeoutMs: 270_000,
    });
    const freeText = buildAskUserComponentContent({
      interruptId: "interrupt_text",
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
      interrupt: { id: "interrupt_choice", timeoutMs: 270_000 },
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

describe("interruptResolvedPropsFromAnswer", () => {
  it("normalizes the resolved patch shape applied to component props", () => {
    expect(
      interruptResolvedPropsFromAnswer({ value: { value: "quick" }, provenance: "user" }),
    ).toEqual({
      resolvedValue: "quick",
      answerProvenance: "user",
    });
  });
});
