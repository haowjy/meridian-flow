/**
 * Tests Anthropic usage normalization across the start and terminal-delta events.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - The terminal message_delta keeps the input categories from message_start
 */
import type Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { mapUsage } from "./stream-collect.js";

it("retains Anthropic input categories when the terminal delta only updates output", () => {
  const initial = mapUsage(
    {
      input_tokens: 111,
      output_tokens: 1,
      cache_read_input_tokens: 1_792,
      cache_creation_input_tokens: 0,
      output_tokens_details: null,
    } as Anthropic.Messages.Usage,
    false,
  );
  const terminal = mapUsage(
    {
      input_tokens: null,
      output_tokens: 74,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens_details: null,
    } as Anthropic.Messages.MessageDeltaUsage,
    false,
    initial,
  );

  expect(terminal).toEqual({ inputTokens: 1_903, outputTokens: 74, cacheReadTokens: 1_792 });
});
