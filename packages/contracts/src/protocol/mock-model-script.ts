/**
 * Purpose: Wire contract for scripting the dev-only mock model: queued replies that answer the next model calls.
 * Why independent: the dev CLI writes scripts and the server's mock gateway consumes them; both validate the same schema.
 */
import { z } from "zod";

export const API_DEBUG_MOCK_MODEL_SCRIPT_PATH = "/api/debug/mock-model/script";

const toolCallSchema = z.strictObject({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

const responseFields = {
  /** Choose one text source: literal text, an authored sample, or generated lorem. */
  text: z.string().max(1_000_000).optional(),
  sample: z.enum(["scene", "critique", "outline", "markdown"]).optional(),
  lorem: z
    .strictObject({
      words: z.number().int().min(1).max(100_000),
      wordsPerParagraph: z.number().int().min(1).max(1_000).optional(),
    })
    .optional(),
  /** Thinking before text/tools; an empty string suppresses a sample's thinking. */
  reasoning: z.string().max(1_000_000).optional(),
  /** Repeat literal/sample text, separated by blank lines. Use lorem.words for lorem size. */
  repeat: z.number().int().min(1).max(100).optional(),
  /** Delay before headers and the first output. */
  delayMs: z.number().int().min(0).max(120_000).optional(),
  /** Unicode characters per text, reasoning, or tool-argument chunk (default 24). */
  chunkSize: z.number().int().min(1).max(65_536).optional(),
  /** Milliseconds between chunks; 0 streams as fast as the connection allows. */
  chunkDelayMs: z.number().int().min(0).max(10_000).optional(),
};

function validTextSource(response: z.infer<typeof responseShape>): boolean {
  return (
    [response.text, response.sample, response.lorem].filter((value) => value !== undefined)
      .length <= 1 &&
    !(response.lorem && response.repeat !== undefined) &&
    (response.text?.length ?? (response.sample ? 10_000 : 0)) * (response.repeat ?? 1) +
      (response.reasoning?.length ?? 0) +
      2 * ((response.repeat ?? 1) - 1) <=
      2_000_000 &&
    (response.repeat === undefined || response.text !== undefined || response.sample !== undefined)
  );
}

const responseShape = z.strictObject(responseFields);
const sourceMessage =
  "choose at most one of text, sample, lorem; repeat needs text/sample; expanded text and reasoning must fit 2,000,000 characters";

/** Repeated defaults cannot execute tools or consume queue-step budgets. */
export const mockModelDefaultResponseSchema = responseShape
  .refine(validTextSource, { message: sourceMessage })
  .refine(
    (response) =>
      response.text !== undefined ||
      response.sample ||
      response.lorem ||
      response.reasoning !== undefined,
    { message: "a default response needs text, sample, lorem, or reasoning" },
  );
export type MockModelDefaultResponse = z.infer<typeof mockModelDefaultResponseSchema>;

/**
 * One step answers `times` model calls (default 1). An error without `times`
 * is sticky, so gateway retries and fallbacks fail deterministically.
 */
export const mockModelStepSchema = z
  .strictObject({
    ...responseFields,
    /** Executed by the real runtime after reasoning/text. End a tool script with a text step. */
    toolCalls: z.array(toolCallSchema).min(1).max(100).optional(),
    /** Truncation/filtering instead of normal completion; partial tools must not execute. */
    finishReason: z.enum(["length", "content_filter"]).optional(),
    error: z
      .strictObject({
        status: z.number().int().min(400).max(599).default(500),
        message: z.string().default("mock provider error"),
      })
      .optional(),
    times: z.number().int().min(1).max(1_000).optional(),
  })
  .refine(validTextSource, { message: sourceMessage })
  .refine(
    (step) =>
      step.text !== undefined ||
      step.sample ||
      step.lorem ||
      step.reasoning !== undefined ||
      step.toolCalls ||
      step.error,
    { message: "a step needs text, sample, lorem, reasoning, toolCalls, or error" },
  )
  .refine(
    (step) =>
      !step.error ||
      [
        step.text,
        step.sample,
        step.lorem,
        step.reasoning,
        step.toolCalls,
        step.finishReason,
        step.repeat,
        step.chunkSize,
        step.chunkDelayMs,
      ].every((value) => value === undefined),
    { message: "error cannot be combined with response content or streaming controls" },
  );

export type MockModelStep = z.infer<typeof mockModelStepSchema>;

export const mockModelScriptSchema = z.strictObject({
  /**
   * Only model calls whose latest user message contains this text consume the
   * script, so concurrent threads do not steal each other's steps. Omitted: any call.
   */
  match: z.string().min(1).optional(),
  steps: z.array(mockModelStepSchema).min(1).max(100),
});

export type MockModelScript = z.infer<typeof mockModelScriptSchema>;

/** Accepts a bare step array as shorthand for `{ steps }`. */
export function parseMockModelScript(
  raw: unknown,
): { ok: true; value: MockModelScript } | { ok: false; error: string } {
  const candidate = Array.isArray(raw) ? { steps: raw } : raw;
  const parsed = mockModelScriptSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "script"}: ${issue.message}`)
      .join("; "),
  };
}

/** `remaining` counts steps left; `sticky` means the head step never runs out. */
export const mockModelScriptStateSchema = z.object({
  scripts: z.array(
    z.object({
      id: z.string().min(1),
      match: z.string().nullable(),
      remaining: z.number().int().nonnegative(),
      sticky: z.boolean(),
    }),
  ),
});
export type MockModelScriptState = z.infer<typeof mockModelScriptStateSchema>;

/** POST response: the queued script's id (for targeted removal) plus the queue. */
export const mockModelScriptEnqueuedSchema = mockModelScriptStateSchema.extend({
  id: z.string().min(1),
});
export type MockModelScriptEnqueued = z.infer<typeof mockModelScriptEnqueuedSchema>;
