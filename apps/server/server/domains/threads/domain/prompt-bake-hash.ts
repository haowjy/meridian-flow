/** Hash the exact serialized system, skill inventory, and advertised-tool bake. */

import { createHash } from "node:crypto";
import type { McpBakedConnection } from "@meridian/contracts/mcp";
import type { JsonValue } from "@meridian/contracts/threads";

/** Every field a bake holds goes in: a field left out would let two different bakes share a row. */
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
