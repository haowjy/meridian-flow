/**
 * Purpose: Verifies the shared ask_user prop contract and interrupt answer helpers that keep server builders and client renderers from drifting.
 */
import { describe, expect, it } from "vitest";

import {
  ASK_USER_TOOL_INPUT_SCHEMA,
  buildInvocationCardContent,
  normalizeInterruptAnswerValue,
  parseAskUserToolInput,
  parseInvocationCard,
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

describe("invocation card contract", () => {
  const identity = {
    agentSlug: "continuity-checker",
    agentName: "Continuity checker",
    parentTurnId: "parent-turn",
    toolCallId: "call-1",
    deliveryMode: "background_notification" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
  };

  it("parses running and completed cards without a duplicated status field", () => {
    const running = buildInvocationCardContent({
      ...identity,
      childThreadId: "child-1",
      execution: null,
      terminalAt: null,
    });
    const completed = buildInvocationCardContent({
      ...identity,
      childThreadId: "child-1",
      execution: "execution-1",
      terminalAt: "2026-01-01T00:01:00.000Z",
      outcome: "succeeded",
    });

    expect(parseInvocationCard(running)).toMatchObject({ terminalAt: null });
    expect(parseInvocationCard(completed)).toMatchObject({ outcome: "succeeded" });
    expect(parseInvocationCard(completed)).not.toHaveProperty("status");
  });

  it("parses admission failures only when they have a readable reason and no child id", () => {
    const failed = {
      kind: "helper-result",
      props: {
        ...identity,
        terminalAt: "2026-01-01T00:01:00.000Z",
        reason: "The selected agent is unavailable.",
      },
    };
    expect(parseInvocationCard(failed)).toMatchObject({
      reason: "The selected agent is unavailable.",
    });
    expect(
      parseInvocationCard({
        ...failed,
        props: { ...failed.props, childThreadId: "not-admitted" },
      }),
    ).toBeNull();
  });

  it("rejects the removed mixed legacy card shape", () => {
    expect(
      parseInvocationCard({
        kind: "helper-result",
        props: { ...identity, status: "completed", summary: "legacy" },
      }),
    ).toBeNull();
  });
});
