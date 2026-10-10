/**
 * One scenario builder for the draft-tree DB tests (contract §16.1): the world and its
 * seed verbs (`draft-tree-seeds.ts`), plus command verbs over the composed production
 * runtime (`draft-tree-commands.ts`) when one is given. Lock interleavings are
 * `lock-interleave.ts`'s.
 */
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
export type { ScenarioSource, ScenarioWork } from "./draft-tree-seeds.js";

/** Seed verbs always; command verbs need `options.runtime` and `options.runtimes`. */
export type DraftTreeScenario = DraftTreeWorld & DraftTreeCommands;

export async function draftTreeScenario(
  db: Database,
  options: { runtime?: ScenarioRuntime; runtimes?: ReturnType<typeof useComposedRuntimes> } = {},
): Promise<DraftTreeScenario> {
  const world = await draftTreeWorld(db);
  const commands = draftTreeCommands(world, () => {
    if (!options.runtime || !options.runtimes) {
      throw new Error("Command verbs need draftTreeScenario(db, { runtime, runtimes })");
    }
    return { runtime: options.runtime, runtimes: options.runtimes };
  });
  return { ...world, ...commands };
}
