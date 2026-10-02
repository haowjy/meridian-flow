/**
 * Shared next-turn model context assembly — the same path the orchestrator uses
 * before gateway.stream(), callable without starting a turn or persisting a bake.
 *
 * Key decisions:
 * - Preview (`persistBake: false`) computes a first-attempt bake in memory only
 *   and returns it as `pendingBake`; the runtime persists it in the delivery commit.
 *   `baked` reflects whether the thread already has an initial bake pointer.
 * - Explicit commit-phase callers may pass `persistBake: true` to persist prompt,
 *   Agent `skills.available` slugs, and advertised tools. Empty Agent available
 *   still writes `[]`. Concurrent attempts use the winning bake row. After first
 *   assembly, dynamic context never rewrites the thread's initial bake.
 * - Runtime freeze commits with the first prepared run start, before model
 *   execution. Later gateway failure or cancellation does not undo that bake.
 */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, PromptBake, Thread, Turn } from "@meridian/contracts/threads";
import type { EventSink } from "../../observability/index.js";
import type { AgentRevisionStore } from "../../packages/index.js";
import {
  bakeInEffect,
  findCutoffOwnerThreadId,
  hashPromptBakeContent,
  type ImageContextBreak,
} from "../../threads/index.js";
import type {
  PromptBakeContent,
  PromptBakeRepository,
  ThreadImageInclusionRepository,
} from "../../threads/ports/repositories.js";
import type { FunctionTool, Gateway, GenerateRequest, ModelInfo, Tool } from "../gateway/index.js";
import type { ImageAssetPort } from "../ports/image-asset.js";
import { resolveAgentThreadTurnContext } from "../tools/agent-thread-context.js";
import {
  resolveThreadModelAvailableSkills,
  resolveThreadPreloadedSkills,
} from "./available-skills.js";
import {
  type ProjectedActiveHistory,
  projectActiveHistoryWithBakes,
  resolveCompactionTrigger,
} from "./compaction/index.js";
import {
  assembleComposedSystemPrompt,
  isThreadPromptFrozen,
  type PromptInventoryListing,
} from "./composed-system-prompt.js";
import { buildContext } from "./context-builder.js";
import {
  type CompactionImageProjectionMode,
  type ImageInclusionDecision,
  projectImageBlocksForModel,
} from "./image-context.js";
import type { EffectiveToolPolicy } from "./permissions/project-tool-policy.js";
import { applyPromptCacheMarks } from "./prompt-cache-marks.js";
import type { WorkContextReader } from "./work-context.js";

/** Baked `Tool[]` is opaque JSON at the contract boundary; the runtime owns its shape. */
function toolsFromBakedJson(value: PromptBake["bakedTools"]): Tool[] | null {
  return Array.isArray(value) ? (value as unknown as Tool[]) : null;
}

export interface AssembleNextTurnContextInput {
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource" | "readRevision">;
  toolRegistry: Parameters<typeof resolveAgentThreadTurnContext>[0]["toolRegistry"];
  gateway?: Pick<Gateway, "getDefaultModel" | "listModels">;
  imageAssets?: ImageAssetPort;
  imageInclusions?: Pick<ThreadImageInclusionRepository, "findByThread">;
  imageProjectionMode?: CompactionImageProjectionMode;
  signal?: AbortSignal;
  persistImageProjection?: (input: {
    afterTurnId: TurnId | null;
    afterTurnPosition: number | null;
    imageProjectionMode?: CompactionImageProjectionMode;
    decisions: readonly ImageInclusionDecision[];
    breaks: readonly ImageContextBreak[];
  }) => Promise<{ turns: Turn[]; blocks: Block[] }>;
  baseTools?: Tool[];
  /** When true, first-attempt bake is persisted immediately; preview/runtime prep pass false. */
  persistBake?: boolean;
  promptBakes: Pick<PromptBakeRepository, "findById">;
  bakeInitialPrompt?: (
    threadId: ThreadId,
    input: PromptBakeContent,
  ) => Promise<{ thread: Thread; bake: PromptBake }>;
  workContext: WorkContextReader;
  eventSink?: EventSink;
}

export interface AssembledNextTurnContext {
  thread: Thread;
  agentSlug: string | null;
  systemPrompt: string;
  tools: FunctionTool[];
  policy: EffectiveToolPolicy;
  gatewayParams: Pick<GenerateRequest, "model" | "reasoning">;
  resolvedModel: ModelInfo | null;
  baked: boolean;
  compactionTriggerTokens: number | null;
  compactionUsableWindowTokens: number | null;
  /** First-attempt prompt freeze staged for the delivery commit, if still needed. */
  pendingBake?: PromptBakeContent;
  generateRequest: Pick<
    GenerateRequest,
    "messages" | "tools" | "model" | "reasoning" | "promptCacheKey"
  >;
  activeHistory: ProjectedActiveHistory;
  imageContextUpdates: { turns: Turn[]; blocks: Block[] };
}

function functionToolsFromAdvertised(tools: Tool[] | undefined): FunctionTool[] {
  return (tools ?? []).filter((tool): tool is FunctionTool => tool.type === "function");
}

export async function composeLivePromptBake(
  input: AssembleNextTurnContextInput,
  agentContext: Awaited<ReturnType<typeof resolveAgentThreadTurnContext>>,
) {
  const thread = input.thread;
  const availableSkills = await resolveThreadModelAvailableSkills({
    thread,
    agentRevisions: input.agentRevisions,
  });
  const preloadedSkills = await resolveThreadPreloadedSkills({
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
    preloadedSkills,
    namedSubagents,
    subagentGuidance: agentContext.subagentGuidance,
  });

  const content = {
    composedSystemPrompt: bakedPrompt,
    bakedSkillSlugs: availableSkills.map((skill) => skill.slug),
    bakedTools: agentContext.tools as unknown as PromptBake["bakedTools"],
  };
  const bakeContent = {
    ...content,
    contentHash: hashPromptBakeContent(content),
  };
  return { bakeContent, bakedPrompt, availableSkills, namedSubagents, workContext, agentContext };
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

  let tools = agentContext.tools;
  let systemPrompt: string;
  let pendingBake: PromptBakeContent | undefined;
  const baked = thread.initialPromptBakeId != null;

  if (isThreadPromptFrozen(thread)) {
    const bake = await bakeInEffect(
      {
        threads: { findByIdIncludingDeleted: async () => thread },
        turns: { listByThread: async () => input.turns },
        promptBakes: input.promptBakes,
      },
      thread,
      input.turns.filter((turn) => turn.threadId === thread.id),
    );
    if (!bake) throw new Error(`Prompt bake not found: ${thread.initialPromptBakeId}`);
    systemPrompt = bake.composedSystemPrompt;
    tools = toolsFromBakedJson(bake.bakedTools) ?? tools;
  } else {
    const { bakeContent, bakedPrompt } = await composeLivePromptBake(input, agentContext);
    if (input.persistBake && input.bakeInitialPrompt) {
      const result = await input.bakeInitialPrompt(thread.id as ThreadId, {
        ...bakeContent,
      });
      thread = result.thread;
      if (!isThreadPromptFrozen(thread))
        throw new Error("Thread prompt freeze returned an unfrozen thread");
      systemPrompt = result.bake.composedSystemPrompt;
      // A losing CAS refetches the winner's frozen tools, mirroring the prompt above.
      tools = toolsFromBakedJson(result.bake.bakedTools) ?? tools;
    } else {
      pendingBake = bakeContent;
      systemPrompt = bakedPrompt;
    }
  }

  const gatewayParams = agentContext.gatewayParams;
  const modelId = gatewayParams.model ?? input.gateway?.getDefaultModel?.();
  const resolvedModel = input.gateway?.listModels?.().find((model) => model.id === modelId);
  const supportsImageInput = resolvedModel?.capabilities.has("image_input") ?? false;
  const usesExplicitPromptCache = resolvedModel?.promptCache.kind === "explicit";
  const activeHistory = await projectActiveHistoryWithBakes(
    input.turns,
    input.blocks,
    input.thread.ref,
    input.promptBakes,
  );
  const savedInclusions = (await input.imageInclusions?.findByThread(thread.id as ThreadId)) ?? [];
  const imageProjection = await projectImageBlocksForModel({
    thread,
    blocks: activeHistory.blocks,
    inclusions: new Map(savedInclusions.map(({ blockId, included }) => [blockId, included])),
    supportsImageInput,
    imageAssets: input.imageAssets ?? {
      async resolve() {
        return null;
      },
    },
    mode: input.imageProjectionMode,
    signal: input.signal,
  });
  const imageContextUpdates =
    input.persistImageProjection &&
    (imageProjection.decisions.length > 0 || imageProjection.breaks.length > 0)
      ? await input.persistImageProjection({
          afterTurnId: (input.turns.at(-1)?.id as TurnId | undefined) ?? null,
          afterTurnPosition: input.turns.at(-1)?.position ?? null,
          imageProjectionMode: input.imageProjectionMode,
          decisions: imageProjection.decisions,
          breaks: imageProjection.breaks,
        })
      : { turns: [], blocks: [] };
  const imageTurnIds = new Set(imageContextUpdates.turns.map((turn) => turn.id));
  const modelHistory = {
    turns: [...activeHistory.turns, ...imageContextUpdates.turns],
    blocks: [
      ...imageProjection.blocks,
      ...imageContextUpdates.blocks.filter((block) => imageTurnIds.has(block.turnId)),
    ],
  };
  const built = buildContext({
    thread,
    ...modelHistory,
    systemPrompt,
    tools,
    eventSink: input.eventSink,
  });
  const contextTools = built.tools;
  const messages = usesExplicitPromptCache ? applyPromptCacheMarks(built.messages) : built.messages;
  const cacheKeyOwner = await findCutoffOwnerThreadId(
    thread,
    async (turnId) => input.turns.find((turn) => turn.id === turnId) ?? null,
  );

  const compactionTrigger = resolvedModel
    ? resolveCompactionTrigger({
        ...agentContext.compaction,
        contextWindow: resolvedModel.contextWindow,
        inputTierTokens: resolvedModel.inputTierTokens,
        maxOutputTokens: resolvedModel.maxOutputTokens,
      })
    : null;
  return {
    thread,
    agentSlug: agentContext.agentSlug,
    systemPrompt,
    tools: functionToolsFromAdvertised(contextTools),
    policy: agentContext.policy,
    gatewayParams,
    resolvedModel: resolvedModel ?? null,
    baked,
    compactionTriggerTokens: compactionTrigger?.thresholdTokens ?? null,
    compactionUsableWindowTokens: compactionTrigger?.usableWindowTokens ?? null,
    ...(pendingBake ? { pendingBake } : {}),
    generateRequest: {
      messages,
      tools: contextTools,
      // Unconditional: a stable
      // per-thread routing hint is harmless for adapters that ignore it
      // (Anthropic has no such concept) and each adapter decides for itself
      // whether to forward it (e.g. OpenAI Responses `prompt_cache_key`). A
      // fork shares the cache route of the thread that owns its cutoff turn.
      promptCacheKey: cacheKeyOwner,
      ...gatewayParams,
    },
    activeHistory: modelHistory,
    imageContextUpdates,
  };
}

/** Persist a first-turn bake inside delivery commit and make its winner authoritative. */
export async function persistPreparedPromptBake(
  assembled: AssembledNextTurnContext,
  bakeInitialPrompt: NonNullable<AssembleNextTurnContextInput["bakeInitialPrompt"]>,
): Promise<void> {
  const pendingBake = assembled.pendingBake;
  if (!pendingBake) return;

  const result = await bakeInitialPrompt(assembled.thread.id as ThreadId, pendingBake);
  assembled.thread = result.thread;
  assembled.baked = true;
  assembled.pendingBake = undefined;
  assembled.systemPrompt = result.bake.composedSystemPrompt;
  const tools = toolsFromBakedJson(result.bake.bakedTools) ?? assembled.generateRequest.tools ?? [];
  // Match buildContext: an empty advertised tool set is omitted from request bytes.
  assembled.generateRequest.tools = tools.length ? tools : undefined;
  assembled.tools = functionToolsFromAdvertised(tools);

  const systemIndex = assembled.generateRequest.messages.findIndex(
    (message) => message.role === "system",
  );
  const systemMessage = assembled.generateRequest.messages[systemIndex];
  if (!systemMessage) throw new Error("Prepared request has no system prompt");
  assembled.generateRequest.messages[systemIndex] = {
    ...systemMessage,
    content: systemMessage.content.map((part) =>
      part.type === "text" ? { ...part, text: assembled.systemPrompt } : part,
    ),
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
