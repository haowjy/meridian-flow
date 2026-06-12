/**
 * Subagent thread row builder and frozen prompt-field parity across adapters.
 * Meridian's current Drizzle schema keeps composed prompt freeze state but not
 * the upstream baked-skill slug list, so mapper parity expects that field null.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryWorkbenchRepository } from "../../workbenches/index.js";
import { mapThread } from "../adapters/drizzle/mappers.js";
import { createInMemoryRepositories } from "../adapters/in-memory/repositories.js";
import {
  buildSubagentThreadRow,
  type CreateSubagentThreadInput,
} from "./thread-create-subagent.js";

function bakedSubagentInput(
  overrides: Partial<CreateSubagentThreadInput> = {},
): CreateSubagentThreadInput {
  return {
    userId: "user-1",
    workbenchId: "workbench-1",
    parentThreadId: "parent-1",
    rootThreadId: "parent-1",
    spawnDepth: 1,
    currentAgent: "agent-one",
    composedSystemPrompt: "Baked prompt with skills.",
    bakedSkillSlugs: ["skill-one"],
    ...overrides,
  };
}

function promptFields(thread: {
  systemPrompt?: string | null;
  composedSystemPrompt?: string | null;
  bakedSkillSlugs?: string[] | null;
}) {
  return {
    systemPrompt: thread.systemPrompt ?? null,
    composedSystemPrompt: thread.composedSystemPrompt ?? null,
    bakedSkillSlugs: thread.bakedSkillSlugs ?? null,
  };
}

function drizzleRowFromBuilt(built: ReturnType<typeof buildSubagentThreadRow>) {
  return {
    id: built.id,
    projectId: built.workbenchId,
    workId: built.workId,
    createdByUserId: built.userId,
    title: built.title ?? "",
    kind: built.kind,
    status: built.status,
    composedSystemPrompt: built.composedSystemPrompt ?? null,
    systemPromptHash: "baked",
    workingState: built.workingState,
    currentAgentId: built.currentAgent,
    nextSeq: 0n,
    parentThreadId: built.parentThreadId,
    originTurnId: null,
    originType: "spawn",
    spawnStatus: built.spawnStatus ?? null,
    spawnResult: built.spawnResult,
    spawnDepth: built.spawnDepth,
    activeLeafTurnId: null,
    turnCount: built.turnCount,
    createdAt: new Date(built.createdAt),
    updatedAt: new Date(built.updatedAt),
    deletedAt: null,
  };
}

describe("buildSubagentThreadRow", () => {
  it("stores baked prompt in composedSystemPrompt with systemPrompt null", () => {
    const row = buildSubagentThreadRow(bakedSubagentInput());
    expect(row.systemPrompt).toBeNull();
    expect(row.composedSystemPrompt).toBe("Baked prompt with skills.");
    expect(row.bakedSkillSlugs).toEqual(["skill-one"]);
  });
});

describe("frozen subagent adapter parity", () => {
  it("in-memory and drizzle mapThread agree on prompt fields for baked subagents", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "WB" });
    const input = bakedSubagentInput({ workbenchId: workbench.id });
    const built = buildSubagentThreadRow(input);
    const inMemory = await repos.threads.createSubagent(input);
    const fromDrizzle = mapThread(drizzleRowFromBuilt(built) as never);

    const expected = {
      systemPrompt: null,
      composedSystemPrompt: "Baked prompt with skills.",
      bakedSkillSlugs: ["skill-one"],
    };
    expect(promptFields(built)).toEqual(expected);
    expect(promptFields(inMemory)).toEqual(expected);
    expect(promptFields(fromDrizzle)).toEqual({ ...expected, bakedSkillSlugs: null });
  });

  it("empty baked set still freezes with systemPrompt null", async () => {
    const workbenchRepo = createInMemoryWorkbenchRepository();
    const repos = createInMemoryRepositories({ workbenches: workbenchRepo });
    const workbench = await workbenchRepo.create({ userId: "user-1", title: "WB" });
    const input = bakedSubagentInput({
      workbenchId: workbench.id,
      composedSystemPrompt: "Baked prompt without invoke.",
      bakedSkillSlugs: [],
    });
    const built = buildSubagentThreadRow(input);
    const inMemory = await repos.threads.createSubagent(input);
    const fromDrizzle = mapThread(drizzleRowFromBuilt(built) as never);

    const expected = {
      systemPrompt: null,
      composedSystemPrompt: "Baked prompt without invoke.",
      bakedSkillSlugs: [],
    };
    expect(promptFields(built)).toEqual(expected);
    expect(promptFields(inMemory)).toEqual(expected);
    expect(promptFields(fromDrizzle)).toEqual({ ...expected, bakedSkillSlugs: null });
  });
});
