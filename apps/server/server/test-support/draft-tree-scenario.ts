import type { UserId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import type { useComposedRuntimes } from "./composed-runtime.js";
import {
  type DraftTreeCommands,
  draftTreeCommands,
  type ScenarioRuntime,
} from "./draft-tree-commands.js";
import { type DraftTreeWorld, draftTreeWorld } from "./draft-tree-seeds.js";

export type {
  ScenarioModel,
  ScenarioReply,
  ScenarioRuntime,
  ScenarioView,
  ScenarioWriter,
} from "./draft-tree-commands.js";
export { itemFor } from "./draft-tree-commands.js";
export type { ScenarioSource, ScenarioWork } from "./draft-tree-seeds.js";

export type DraftTreeScenario = DraftTreeWorld &
  DraftTreeCommands & {
    another(scope: "project" | "account"): Promise<DraftTreeScenario>;
  };

export async function draftTreeScenario(
  db: Database,
  options: {
    runtime?: ScenarioRuntime;
    runtimes?: ReturnType<typeof useComposedRuntimes>;
    account?: UserId;
  } = {},
): Promise<DraftTreeScenario> {
  const world = await draftTreeWorld(db, options.account ? { account: options.account } : {});
  const commands = draftTreeCommands(world, () => {
    if (!options.runtime || !options.runtimes) {
      throw new Error("Command verbs need draftTreeScenario(db, { runtime, runtimes })");
    }
    return { runtime: options.runtime, runtimes: options.runtimes };
  });
  return {
    ...world,
    ...commands,
    another: (scope) => {
      const { account: _, ...runtime } = options;
      return draftTreeScenario(
        db,
        scope === "project" ? { ...runtime, account: world.project.userId } : runtime,
      );
    },
  };
}
