/** History guidance follows the persisted prompt epoch, not the current Agent binding. */
import type { PromptBake, Turn } from "@meridian/contracts/threads";
import { bakeAt, type ThreadRepositories } from "../../threads/index.js";
import type { ToolRegistry } from "../tools/types.js";
import { isJsonObject } from "./block-helpers.js";

export function bakeHasHistoryTool(bake: Pick<PromptBake, "bakedTools">): boolean {
  return (
    Array.isArray(bake.bakedTools) &&
    bake.bakedTools.some((tool) => isJsonObject(tool) && tool.name === "thread_history")
  );
}

export async function historyReadableAt(
  deps: {
    repos: Pick<ThreadRepositories, "threads" | "turns" | "promptBakes">;
    /** Absent in runtimes that register no tools. */
    toolRegistry?: Pick<ToolRegistry, "getRegistration">;
  },
  turn: Turn,
  knownTurns?: readonly Turn[],
): Promise<boolean> {
  const bake = await bakeAt(deps.repos, turn, knownTurns);
  return bake
    ? bakeHasHistoryTool(bake)
    : deps.toolRegistry?.getRegistration("thread_history") !== undefined;
}
