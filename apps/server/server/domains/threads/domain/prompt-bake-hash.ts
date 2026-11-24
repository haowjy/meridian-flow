import { createHash } from "node:crypto";
import type { McpBakedConnection } from "@meridian/contracts/mcp";
import type { JsonValue } from "@meridian/contracts/threads";

export function hashPromptBakeContent(input: {
  composedSystemPrompt: string;
  bakedSkillSlugs: string[];
  bakedTools: JsonValue;
  bakedConnections: McpBakedConnection[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.composedSystemPrompt,
        input.bakedSkillSlugs,
        input.bakedTools,
        input.bakedConnections,
      ]),
    )
    .digest("hex");
}
