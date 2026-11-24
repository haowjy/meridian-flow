import type { ToolPolicy } from "@meridian/contracts/agents";
import type { McpBakedConnection } from "@meridian/contracts/mcp";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, PromptBake, Thread, ThreadOverrides, Turn } from "@meridian/contracts/threads";
import type { Gateway, GenerateRequest, ModelInfo, Tool } from "@meridian-flow/runtime/gateway";
import type { EventSink } from "../../observability/index.js";
import type { AgentRevisionStore } from "../../packages/index.js";
import {
  bakeInEffect,
  findCutoffOwnerThreadId,
  hashPromptBakeContent,
  type MediaContextBreak,
} from "../../threads/index.js";
import type {
  PromptBakeContent,
  PromptBakeRepository,
  ThreadMediaInclusionRepository,
} from "../../threads/ports/repositories.js";
import type { ConnectionBake, ConnectionsPort } from "../ports/connections.js";
import { type MediaResolverPort, unavailableMediaResolver } from "../ports/media-resolver.js";
import {
  type ResolveAgentThreadTurnContextInput,
  resolveAgentThreadTurnContext,
} from "../tools/agent-thread-context.js";
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
import {
  buildContext,
  connectionCallKey,
  turnsWithUnfinishedConnectionCalls,
} from "./context-builder.js";
import {
  type CompactionMediaProjectionMode,
  type MediaInclusionDecision,
  mediaUnitKey,
  projectMediaBlocksForModel,
} from "./media-context.js";
import { linkWindowAt } from "./media-link-window.js";
import { linkWindowSeconds, promptCacheRetentionFor } from "./prefix-cache-state.js";
import type { WorkContextReader } from "./work-context.js";

function toolsFromBakedJson(value: PromptBake["bakedTools"]): Tool[] | null {
  return Array.isArray(value) ? (value as unknown as Tool[]) : null;
}

function withInvokedSkillTool(baked: Tool[], live: Tool[]): Tool[] {
  const isSkill = (tool: Tool) => tool.name === "skill";
  if (baked.some(isSkill)) return baked;
  const skill = live.find(isSkill);
  return skill ? [...baked, skill] : baked;
}

export interface AssembleNextTurnContextInput {
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  agentRevisions: Pick<AgentRevisionStore, "readThreadBinding" | "readSource" | "readRevision">;
  agentCatalog: ResolveAgentThreadTurnContextInput["agentCatalog"];
  threads: Parameters<typeof resolveAgentThreadTurnContext>[0]["threads"];
  toolRegistry: Parameters<typeof resolveAgentThreadTurnContext>[0]["toolRegistry"];
  gateway: Pick<Gateway, "getDefaultModel" | "listModels">;
  mediaResolver?: MediaResolverPort;
  mediaLinkWindowSeconds?: number;
  mediaInclusions?: Pick<ThreadMediaInclusionRepository, "findByThread">;
  mediaProjectionMode?: CompactionMediaProjectionMode;
  signal?: AbortSignal;
  persistMediaProjection?: (input: {
    afterTurnId: TurnId | null;
    afterTurnPosition: number | null;
    mediaProjectionMode?: CompactionMediaProjectionMode;
    decisions: readonly MediaInclusionDecision[];
    breaks: readonly MediaContextBreak[];
  }) => Promise<{ turns: Turn[]; blocks: Block[] }>;
  baseTools?: Tool[];
  persistBake?: boolean;
  promptBakes: Pick<PromptBakeRepository, "findById">;
  bakeInitialPrompt?: (
    threadId: ThreadId,
    input: PromptBakeContent,
  ) => Promise<{ thread: Thread; bake: PromptBake }>;
  workContext: WorkContextReader;
  connections?: ConnectionsPort;
  eventSink?: EventSink;
}

export interface AssembledNextTurnContext {
  thread: Thread;
  agentSlug: string | null;
  systemPrompt: string;
  tools: Tool[];
  policy: ToolPolicy;
  gatewayParams: Pick<GenerateRequest, "model" | "reasoning">;
  resolvedModel: ModelInfo | null;
  baked: boolean;
  bakedConnections: McpBakedConnection[];
  compactionTriggerTokens: number | null;
  compactionUsableWindowTokens: number | null;
  pendingBake?: PromptBakeContent;
  generateRequest: Pick<
    GenerateRequest,
    "messages" | "tools" | "model" | "reasoning" | "promptCacheKey" | "promptCacheRetention"
  >;
  activeHistory: ProjectedActiveHistory;
  creditedBlockIds: ReadonlySet<string>;
  preparationUpdates: { turns: Turn[]; blocks: Block[] };
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
  const connections: ConnectionBake =
    agentContext.policy.has("mcp_call") && input.connections
      ? await input.connections.bake(thread)
      : { bakedConnections: [], catalogue: null };
  const bakedPrompt = assembleComposedSystemPrompt({
    basePrompt: agentContext.agentBody,
    appendPrompt: agentContext.appendPrompt,
    workContext,
    permissionGuidance: agentContext.permissionGuidance,
    availableSkills,
    preloadedSkills,
    namedSubagents,
    connectionCatalogue: connections.catalogue,
    subagentGuidance: agentContext.subagentGuidance,
  });

  const content = {
    composedSystemPrompt: bakedPrompt,
    bakedSkillSlugs: availableSkills.map((skill) => skill.slug),
    bakedTools: agentContext.tools as unknown as PromptBake["bakedTools"],
    bakedConnections: connections.bakedConnections,
  };
  const bakeContent = {
    ...content,
    contentHash: hashPromptBakeContent(content),
  };
  return { bakeContent, bakedPrompt, availableSkills, namedSubagents, workContext, agentContext };
}

async function recordedConnectionCalls(
  connections: ConnectionsPort | undefined,
  threadId: string,
  history: { turns: readonly Turn[]; blocks: readonly Block[] },
): Promise<Map<string, string[]>> {
  const unfinished = connections
    ? turnsWithUnfinishedConnectionCalls(history.turns, history.blocks)
    : [];
  const recorded = new Map<string, string[]>();
  if (!connections || unfinished.length === 0) return recorded;
  for (const { turnId, toolCallId, line } of await connections.recordedCalls(
    threadId,
    unfinished,
  )) {
    const key = connectionCallKey(turnId, toolCallId);
    recorded.set(key, [...(recorded.get(key) ?? [connections.callsRan]), line]);
  }
  return recorded;
}

interface PreparedNextTurnContext
  extends Omit<AssembledNextTurnContext, "tools" | "generateRequest"> {
  advertisedTools: Tool[];
  recordedCalls: ReadonlyMap<string, readonly string[]>;
  promptCacheKey: ThreadId;
  eventSink?: EventSink;
}

function turnGatewayParams(
  gateway: AssembleNextTurnContextInput["gateway"],
  thread: Pick<Thread, "overrides">,
  agentParams: Pick<GenerateRequest, "model" | "reasoning">,
): Pick<GenerateRequest, "model" | "reasoning"> {
  const model = threadModelId(gateway, thread.overrides, agentParams.model);
  const effort = thread.overrides.effort;
  return effort ? { ...agentParams, model, reasoning: effort } : { ...agentParams, model };
}

export function threadModelId(
  gateway: Pick<Gateway, "listModels">,
  overrides: ThreadOverrides,
  agentModel: string | undefined,
): string | undefined {
  const override = overrides.model;
  return override && gateway.listModels().some((model) => model.id === override)
    ? override
    : agentModel;
}

function modelOf(
  gateway: AssembleNextTurnContextInput["gateway"],
  params: Pick<GenerateRequest, "model">,
): ModelInfo | undefined {
  const modelId = params.model ?? gateway.getDefaultModel();
  return gateway.listModels().find((model) => model.id === modelId);
}

export function lazyThreadModel(
  input: Pick<
    AssembleNextTurnContextInput,
    | "thread"
    | "agentRevisions"
    | "agentCatalog"
    | "threads"
    | "toolRegistry"
    | "gateway"
    | "baseTools"
  >,
): () => Promise<ModelInfo | undefined> {
  let model: Promise<ModelInfo | undefined> | undefined;
  return () =>
    (model ??= resolveAgentThreadTurnContext({ ...input, baseTools: input.baseTools }).then(
      (context) =>
        modelOf(
          input.gateway,
          turnGatewayParams(input.gateway, input.thread, context.gatewayParams),
        ),
    ));
}

export async function assembleNextTurnContext(
  input: AssembleNextTurnContextInput,
): Promise<AssembledNextTurnContext> {
  return renderPreparedTurnContext(await prepareNextTurnContext(input));
}

export async function prepareNextTurnContext(
  input: AssembleNextTurnContextInput,
): Promise<PreparedNextTurnContext> {
  let thread = input.thread;
  const agentContext = await resolveAgentThreadTurnContext({
    thread,
    agentRevisions: input.agentRevisions,
    agentCatalog: input.agentCatalog,
    threads: input.threads,
    toolRegistry: input.toolRegistry,
    baseTools: input.baseTools,
  });

  let tools = agentContext.tools;
  let systemPrompt: string;
  let pendingBake: PromptBakeContent | undefined;
  let bakedConnections: McpBakedConnection[];
  const baked = thread.initialPromptBakeId != null;

  if (isThreadPromptFrozen(thread)) {
    const bake = await bakeInEffect(
      {
        threads: { findByIdIncludingDeleted: async () => ({ ...thread, project: null }) },
        turns: { listByThread: async () => input.turns },
        promptBakes: input.promptBakes,
      },
      thread,
      input.turns.filter((turn) => turn.threadId === thread.id),
    );
    if (!bake) throw new Error(`Prompt bake not found: ${thread.initialPromptBakeId}`);
    systemPrompt = bake.composedSystemPrompt;
    bakedConnections = bake.bakedConnections;
    tools = withInvokedSkillTool(toolsFromBakedJson(bake.bakedTools) ?? tools, agentContext.tools);
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
      bakedConnections = result.bake.bakedConnections;
      tools = toolsFromBakedJson(result.bake.bakedTools) ?? tools;
    } else {
      pendingBake = bakeContent;
      systemPrompt = bakedPrompt;
      bakedConnections = bakeContent.bakedConnections;
    }
  }

  const gatewayParams = turnGatewayParams(input.gateway, thread, agentContext.gatewayParams);
  const resolvedModel = modelOf(input.gateway, gatewayParams);
  const activeHistory = await projectActiveHistoryWithBakes(
    input.turns,
    input.blocks,
    input.thread.ref,
    input.promptBakes,
  );
  const savedInclusions = (await input.mediaInclusions?.findByThread(thread.id as ThreadId)) ?? [];
  const mediaProjection = await projectMediaBlocksForModel({
    thread,
    blocks: activeHistory.blocks,
    inclusions: new Map(
      savedInclusions.map(({ blockId, partIndex, included }) => [
        mediaUnitKey(blockId, partIndex),
        included,
      ]),
    ),
    model: resolvedModel ?? null,
    media: input.mediaResolver ?? unavailableMediaResolver,
    window: linkWindowAt(
      Date.now(),
      linkWindowSeconds(resolvedModel ?? null, thread.kind, input.mediaLinkWindowSeconds),
    ),
    mode: input.mediaProjectionMode,
    signal: input.signal,
  });
  const preparationUpdates =
    input.persistMediaProjection &&
    (mediaProjection.decisions.length > 0 || mediaProjection.breaks.length > 0)
      ? await input.persistMediaProjection({
          afterTurnId: (input.turns.at(-1)?.id as TurnId | undefined) ?? null,
          afterTurnPosition: input.turns.at(-1)?.position ?? null,
          mediaProjectionMode: input.mediaProjectionMode,
          decisions: mediaProjection.decisions,
          breaks: mediaProjection.breaks,
        })
      : { turns: [], blocks: [] };
  const imageTurnIds = new Set(preparationUpdates.turns.map((turn) => turn.id));
  const modelHistory = {
    turns: [...activeHistory.turns, ...preparationUpdates.turns],
    blocks: [
      ...mediaProjection.blocks,
      ...preparationUpdates.blocks.filter((block) => imageTurnIds.has(block.turnId)),
    ],
  };
  const cacheKeyOwner = await findCutoffOwnerThreadId(
    thread,
    async (turnId) => input.turns.find((turn) => turn.id === turnId) ?? null,
  );

  const compactionTrigger = resolvedModel
    ? resolveCompactionTrigger({
        contextWindow: resolvedModel.contextWindow,
        inputTierTokens: resolvedModel.inputTierTokens,
        maxOutputTokens: resolvedModel.maxOutputTokens,
      })
    : null;
  return {
    thread,
    agentSlug: agentContext.agentSlug,
    systemPrompt,
    advertisedTools: tools,
    recordedCalls: await recordedConnectionCalls(input.connections, thread.id, modelHistory),
    promptCacheKey: cacheKeyOwner,
    eventSink: input.eventSink,
    policy: agentContext.policy,
    gatewayParams,
    resolvedModel: resolvedModel ?? null,
    baked,
    bakedConnections,
    compactionTriggerTokens: compactionTrigger?.thresholdTokens ?? null,
    compactionUsableWindowTokens: compactionTrigger?.usableWindowTokens ?? null,
    ...(pendingBake ? { pendingBake } : {}),
    activeHistory: modelHistory,
    creditedBlockIds: activeHistory.creditedBlockIds,
    preparationUpdates,
  };
}

export function renderPreparedTurnContext(
  prepared: PreparedNextTurnContext,
): AssembledNextTurnContext {
  const { advertisedTools, recordedCalls, promptCacheKey, eventSink, ...context } = prepared;
  const built = buildContext({
    thread: context.thread,
    ...context.activeHistory,
    systemPrompt: context.systemPrompt,
    tools: advertisedTools,
    recordedCalls,
    eventSink,
  });
  return {
    ...context,
    tools: built.tools ?? [],
    generateRequest: {
      messages: built.messages,
      tools: built.tools,
      promptCacheKey,
      promptCacheRetention: promptCacheRetentionFor(context.thread.kind),
      ...context.gatewayParams,
    },
  };
}

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
  assembled.bakedConnections = result.bake.bakedConnections;
  const tools = toolsFromBakedJson(result.bake.bakedTools) ?? assembled.generateRequest.tools ?? [];
  assembled.generateRequest.tools = tools.length ? tools : undefined;
  assembled.tools = tools;

  const systemIndex = assembled.generateRequest.messages.findIndex(
    (message) => message.role === "system",
  );
  const systemMessage = assembled.generateRequest.messages[systemIndex];
  if (systemMessage?.role !== "system") throw new Error("Prepared request has no system prompt");
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
