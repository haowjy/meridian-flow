/**
 * Purpose: Wire contract for scripting the dev-only mock model: queued replies that answer the next model calls.
 * Why independent: the dev CLI writes scripts and the server's mock gateway consumes them; both validate the same schema.
 */
import { z } from "zod";

export const API_DEBUG_MOCK_MODEL_SCRIPT_PATH = "/api/debug/mock-model/script";

const toolCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** One step answers exactly one model call. */
export const mockModelStepSchema = z
  .object({
    /** Assistant prose streamed word by word. */
    text: z.string().optional(),
    /** Tool calls the model makes in this response (after any text). */
    toolCalls: z.array(toolCallSchema).min(1).optional(),
    /** Provider failure instead of a response. */
    error: z
      .object({
        status: z.number().int().min(400).max(599).default(500),
        message: z.string().default("mock provider error"),
      })
      .optional(),
    /** Delay before the response starts. */
    delayMs: z.number().int().min(0).max(120_000).optional(),
  })
  .refine((step) => step.text !== undefined || step.toolCalls || step.error, {
    message: "a step needs text, toolCalls, or error",
  });

export type MockModelStep = z.infer<typeof mockModelStepSchema>;

export const mockModelScriptSchema = z.object({
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

export type MockModelScriptState = {
  scripts: { id: string; match: string | null; remaining: number }[];
};
