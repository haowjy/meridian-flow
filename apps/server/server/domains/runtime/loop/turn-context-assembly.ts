/**
 * Shared next-turn model context assembly — the same path the orchestrator uses
 * before gateway.stream(), callable without starting a turn or persisting a bake.
 *
 * Key decisions:
 * - Preview (`persistBake: false`) computes a would-be first-attempt bake in memory
 *   only; `baked` in the response still reflects persisted `bakedSkillSlugs`.
 * - Orchestrator (`persistBake: true`) atomically persists prompt + Agent
 *   `skills.available` slugs on first attempt via compare-and-swap
 *   `bakeComposedSystemPrompt`. Empty Agent available still writes `[]`. A losing
 *   concurrent bake refetches and uses the winner's frozen prompt + slugs. After
 *   freeze, dynamic context never rewrites the prompt.
 * - Freeze happens at first turn attempt (context assembly), even if the gateway
 *   send then fails or is cancelled.
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import type { AgentRevisionStore } from "../../packages/index.js";
import type { BakeComposedSystemPromptInput } from "../../threads/ports/repositories.js";
import type { FunctionTool, Gateway, GenerateRequest, Tool } from "../gateway/index.js";
import type { ImageAssetPort } from "../ports/image-asset.js";
import { resolveAgentThreadTurnContext } from "../tools/agent-thread-context.js";
import {
  type AvailableSkillListing,
  resolveThreadModelAvailableSkills,
} from "./available-skills.js";
import {
  assembleComposedSystemPrompt,
  isThreadPromptFrozen,
  type PromptInventoryListing,
} from "./composed-system-prompt.js";
import { type BuildContextInput, buildContext } from "./context-builder.js";
import { projectImageBlocksForModel } from "./image-context.js";
import type { EffectiveToolPolicy } from "./permissions/project-tool-policy.js";
import type { WorkContextReader } from "./work-context.js";

export interface AssembleNextTurnContextInput {
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  skillBodiesByTurn?: BuildContextInput["skillBodiesByTurn"];
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource" | "readRevision">;
  toolRegistry: Parameters<typeof resolveAgentThreadTurnContext>[0]["toolRegistry"];
  gateway?: Pick<Gateway, "getDefaultModel" | "listModels">;
  imageAssets?: ImageAssetPort;
  baseTools?: Tool[];
  /** When true, first-attempt bake is persisted; preview callers pass false. */
  persistBake?: boolean;
  bakeComposedSystemPrompt?: (
    threadId: ThreadId,
    input: BakeComposedSystemPromptInput,
  ) => Promise<Thread>;
  workContext: WorkContextReader;
}

export interface AssembledNextTurnContext {
  thread: Thread;
  agentSlug: string | null;
  systemPrompt: string;
  tools: FunctionTool[];
  policy: EffectiveToolPolicy;
  gatewayParams: Pick<GenerateRequest, "model" | "reasoning">;
  baked: boolean;
  generateRequest: Pick<GenerateRequest, "messages" | "tools" | "model" | "reasoning">;
}

function functionToolsFromAdvertised(tools: Tool[] | undefined): FunctionTool[] {
  return (tools ?? []).filter((tool): tool is FunctionTool => tool.type === "function");
}

/** Assemble the next model request context — shared by orchestrator and debug preview. */
export async function assembleNextTurnContext(
  input: AssembleNextTurnContextInput,
): Promise<AssembledNextTurnContext> {
  let thread = input.thread;
  const agentContext = await resolveAgentThreadTurnContext({
    thread,
    agentRevisions: input.agentRevisions,
    toolRegistry: input.toolRegistry,
    baseTools: input.baseTools,
  });

  const tools = agentContext.tools;
  let workContextSection: string | undefined;
  let unfrozenBasePrompt: string | null | undefined;
  let appendPromptForUnfrozen: string | undefined;
  let availableSkillsForUnfrozen: AvailableSkillListing[] | undefined;
  let namedSubagentsForUnfrozen: PromptInventoryListing[] | undefined;
  let subagentGuidanceForUnfrozen: string | undefined;
  let systemPrompt: string;
  const baked = thread.bakedSkillSlugs != null;

  if (isThreadPromptFrozen(thread)) {
    systemPrompt = thread.composedSystemPrompt ?? "";
  } else {
    const availableSkills = await resolveThreadModelAvailableSkills({
      thread,
      agentRevisions: input.agentRevisions,
    });
    const namedSubagents = await resolveNamedSubagentListings({
      thread,
      agentRevisions: input.agentRevisions,
    });
    const workContext = (await input.workContext.renderForThread(thread.id as ThreadId)).text;
    const bakedPrompt = assembleComposedSystemPrompt({
      basePrompt: agentContext.agentBody,
      appendPrompt: agentContext.appendPrompt,
      workContext,
      availableSkills,
      namedSubagents,
      subagentGuidance: agentContext.subagentGuidance,
    });

    if (input.persistBake && input.bakeComposedSystemPrompt) {
      thread = await input.bakeComposedSystemPrompt(thread.id as ThreadId, {
        composedSystemPrompt: bakedPrompt,
        bakedSkillSlugs: availableSkills.map((skill) => skill.slug),
      });
      if (!isThreadPromptFrozen(thread))
        throw new Error("Thread prompt freeze returned an unfrozen thread");
      systemPrompt = thread.composedSystemPrompt ?? bakedPrompt;
    } else {
      systemPrompt = bakedPrompt;
      unfrozenBasePrompt = agentContext.agentBody;
      appendPromptForUnfrozen = agentContext.appendPrompt;
      workContextSection = workContext;
      availableSkillsForUnfrozen = availableSkills;
      namedSubagentsForUnfrozen = namedSubagents;
      subagentGuidanceForUnfrozen = agentContext.subagentGuidance;
    }
  }

  const gatewayParams = agentContext.gatewayParams;
  const modelId = gatewayParams.model ?? input.gateway?.getDefaultModel?.();
  const supportsImageInput =
    input.gateway
      ?.listModels?.()
      .find((model) => model.id === modelId)
      ?.capabilities.has("image_input") ?? false;
  const blocks = await projectImageBlocksForModel({
    thread,
    blocks: input.blocks,
    supportsImageInput,
    imageAssets: input.imageAssets ?? {
      async resolve() {
        return null;
      },
    },
  });
  const { messages, tools: contextTools } = buildContext({
    thread,
    turns: input.turns,
    blocks,
    skillBodiesByTurn: input.skillBodiesByTurn,
    tools,
    unfrozenBasePrompt,
    appendPrompt: appendPromptForUnfrozen,
    workContext: workContextSection,
    availableSkills: availableSkillsForUnfrozen,
    namedSubagents: namedSubagentsForUnfrozen,
    subagentGuidance: subagentGuidanceForUnfrozen,
  });

  return {
    thread,
    agentSlug: agentContext.agentSlug,
    systemPrompt,
    tools: functionToolsFromAdvertised(contextTools),
    policy: agentContext.policy,
    gatewayParams,
    baked,
    generateRequest: {
      messages,
      tools: contextTools,
      ...gatewayParams,
    },
  };
}

async function resolveNamedSubagentListings(input: {
  thread: Thread;
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readRevision">;
}): Promise<PromptInventoryListing[]> {
  const binding = await input.agentRevisions.readThreadBinding(input.thread.id);
  if (!binding) return [];
  const listings: PromptInventoryListing[] = [];
  for (const target of binding.configuration.namedTargets) {
    const revision = await input.agentRevisions.readRevision(target.definitionRevisionId);
    listings.push({
      slug: target.name,
      name: revision?.definition.metadata.name ?? target.name,
      description: revision?.definition.metadata.description ?? "",
    });
  }
  return listings;
}
