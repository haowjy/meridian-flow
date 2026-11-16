/**
 * Purpose: JSON-natural preview of the next turn's model context — system prompt,
 * advertised function tools, and gateway params. Dev-only; no side effects.
 * Key decisions: mirrors gateway Tool shape; `baked` reflects persisted
 * first-attempt bake pointer, not a would-be bake preview.
 */
import type { JsonValue } from "./index.js";

/** Function tool definition as advertised to the gateway on the next turn. */
export type TurnContextPreviewFunctionTool = {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
};

/** Owner-gated debug preview of what the orchestrator would send on the next model call. */
export type TurnContextPreview = {
  /** Bound revision slug at preview time. */
  agentSlug: string | null;
  /** Primary gateway system prompt (frozen bake or would-be first-attempt bake). */
  systemPrompt: string;
  /** True when the thread has a persisted first-attempt bake pointer. */
  baked: boolean;
  tools: TurnContextPreviewFunctionTool[];
  gatewayParams: {
    model?: string;
    /** `GenerateRequest.reasoning`: the level asked for; absent means the model's own default. */
    reasoning?: string;
  };
};

type AssertJsonValue<T extends JsonValue> = T;
type _TurnContextPreviewIsJsonValue = AssertJsonValue<TurnContextPreview>;
