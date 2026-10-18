/**
 * One scenario builder for the draft-tree DB tests (contract §16.1): the world and its
 * seed verbs (`draft-tree-seeds.ts`), plus command verbs over the composed production
 * runtime (`draft-tree-commands.ts`) when one is given. Lock interleavings are
 * `lock-interleave.ts`'s.
 */
import type { UserId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  type BranchTreeCommands,
  branchTreeCommands,
  type ScenarioRuntime,
} from "./branch-tree-commands.js";
import { type BranchTreeWorld, branchTreeWorld } from "./branch-tree-seeds.js";
import type { useComposedRuntimes } from "./composed-runtime.js";

export type {
  ScenarioModel,
  ScenarioReply,
  ScenarioRuntime,
  ScenarioView,
  ScenarioWriter,
} from "./branch-tree-commands.js";
export { itemFor, typeLink } from "./branch-tree-commands.js";
export type { ScenarioSource, ScenarioWork } from "./branch-tree-seeds.js";

/** Seed verbs always; command verbs need `options.runtime` and `options.runtimes`. */
export type BranchTreeScenario = BranchTreeWorld &
  BranchTreeCommands & {
    /** A second scenario on the same runtime: another project of this account, or a stranger's. */
    another(scope: "project" | "account"): Promise<BranchTreeScenario>;
  };

export async function branchTreeScenario(
  db: Database,
  options: {
    runtime?: ScenarioRuntime;
    runtimes?: ReturnType<typeof useComposedRuntimes>;
    account?: UserId;
  } = {},
): Promise<BranchTreeScenario> {
  const world = await branchTreeWorld(db, options.account ? { account: options.account } : {});
  const commands = branchTreeCommands(world, () => {
    if (!options.runtime || !options.runtimes) {
      throw new Error("Command verbs need branchTreeScenario(db, { runtime, runtimes })");
    }
    return { runtime: options.runtime, runtimes: options.runtimes };
  });
  return {
    ...world,
    ...commands,
    another: (scope) => {
      const { account: _, ...runtime } = options;
      return branchTreeScenario(
        db,
        scope === "project" ? { ...runtime, account: world.project.userId } : runtime,
      );
    },
  };
}
