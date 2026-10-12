/** Hash the exact serialized system, skill inventory, and advertised-tool bake. */

import { createHash } from "node:crypto";
import type { JsonValue } from "@meridian/contracts/threads";

export function hashPromptBakeContent(input: {
  composedSystemPrompt: string;
  bakedSkillSlugs: string[];
  bakedTools: JsonValue;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.composedSystemPrompt, input.bakedSkillSlugs, input.bakedTools]))
    .digest("hex");
}
