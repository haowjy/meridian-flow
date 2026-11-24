import type { JsonValue } from "./index.js";

export type TurnContextPreviewFunctionTool = {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
};

export type TurnContextPreview = {
  agentSlug: string | null;
  systemPrompt: string;
  baked: boolean;
  tools: TurnContextPreviewFunctionTool[];
  gatewayParams: {
    model?: string;
    reasoning?: string;
  };
};

type AssertJsonValue<T extends JsonValue> = T;
type _TurnContextPreviewIsJsonValue = AssertJsonValue<TurnContextPreview>;
