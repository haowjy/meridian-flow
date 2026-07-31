/** Provider-neutral model capabilities shared by the gateway and client-facing thread state. */

export const MODEL_CAPABILITIES = [
  "streaming",
  "tool_calling",
  "parallel_tool_calls",
  "image_input",
  "image_output",
  "file_input",
  "structured_output",
  "reasoning",
  "caching",
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
