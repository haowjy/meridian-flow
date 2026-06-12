/**
 * Purpose: JSON-natural preview of the next turn's model context — system prompt,
 * advertised function tools, and gateway params. Dev-only; no side effects.
 * Key decisions: mirrors gateway FunctionTool shape; `baked` reflects persisted
 * first-attempt freeze (`bakedSkillSlugs !== null`), not a would-be bake preview.
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
  /** `thread.currentAgent` at preview time. */
  agentSlug: string | null;
  /** Primary gateway system prompt (frozen bake or would-be first-attempt bake). */
  systemPrompt: string;
  /** True when the thread has completed first-attempt bake (`bakedSkillSlugs !== null`). */
  baked: boolean;
  tools: TurnContextPreviewFunctionTool[];
  gatewayParams: {
    model?: string;
    reasoning?: "disabled" | "adaptive" | { effort: "low" | "medium" | "high" | "max" };
  };
};

type AssertJsonValue<T extends JsonValue> = T;
type _TurnContextPreviewIsJsonValue = AssertJsonValue<TurnContextPreview>;
