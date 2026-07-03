/**
 * Shared next-turn model context assembly — the same path the orchestrator uses
 * before gateway.stream(), callable without starting a turn or persisting a bake.
 *
 * Key decisions:
 * - Preview (`persistBake: false`) computes a would-be first-attempt bake in memory
 *   only; `baked` in the response still reflects persisted `bakedSkillSlugs`.
 * - Orchestrator (`persistBake: true`) atomically persists prompt + skill contract
 *   on first attempt via compare-and-swap `bakeComposedSystemPrompt`. A losing
 *   concurrent bake refetches and uses the winner's frozen prompt + slugs.
 * - Freeze happens at first turn attempt (context assembly), even if the gateway
 *   send then fails or is cancelled; autoprune is the only future re-bake trigger.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import type { DraftLifecycleEvent } from "../../collab/domain/drafts.js";
import type { PackageRepository, ResolvedSkill } from "../../packages/index.js";
import type { BakeComposedSystemPromptInput } from "../../threads/ports/repositories.js";
import type { PendingUndoNotification } from "../../undo-notifications/index.js";
import type { FunctionTool, GenerateRequest, Tool } from "../gateway/index.js";
import {
  applyBakedInvokeAdvertisement,
  resolveAgentThreadTurnContext,
} from "../tools/agent-thread-context.js";
import { modelInvocableSkillSlugs } from "../tools/skill-tools.js";
import { isThreadPromptFrozen, rebakeComposedSystemPrompt } from "./composed-system-prompt.js";
import { buildContext } from "./context-builder.js";

const MAX_REBIND_BAKE_ATTEMPTS = 3;

export interface AssembleNextTurnContextInput {
  thread: Thread;
  turns: Turn[];
  blocks: Block[];
  packageRepository: PackageRepository;
  toolRegistry: Parameters<typeof resolveAgentThreadTurnContext>[0]["toolRegistry"];
  baseTools?: Tool[];
  /** When true, first-attempt bake is persisted; preview callers pass false. */
  persistBake?: boolean;
  bakeComposedSystemPrompt?: (
    threadId: ThreadId,
    input: BakeComposedSystemPromptInput,
  ) => Promise<Thread>;
  undoNotifications?: readonly PendingUndoNotification[];
  draftLifecycleEvents?: readonly DraftLifecycleEvent[];
}

export interface AssembledNextTurnContext {
  thread: Thread;
  agentSlug: string | null;
  resolvedSkills: ResolvedSkill[];
  systemPrompt: string;
  tools: FunctionTool[];
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
  let attempt = 0;

  while (true) {
    const agentContext = await resolveAgentThreadTurnContext({
      thread,
      packageRepository: input.packageRepository,
      toolRegistry: input.toolRegistry,
      baseTools: input.baseTools,
    });

    let tools = agentContext.tools;
    let skillsSystemPromptSection: string | undefined;
    let systemPrompt: string;
    const baked = thread.bakedSkillSlugs != null;

    if (isThreadPromptFrozen(thread)) {
      tools = applyBakedInvokeAdvertisement({
        tools,
        bakedSkillSlugs: thread.bakedSkillSlugs,
        toolRegistry: input.toolRegistry,
      });
      systemPrompt = thread.composedSystemPrompt ?? "";
    } else {
      const bakedPrompt = rebakeComposedSystemPrompt({
        basePrompt: thread.systemPrompt ?? agentContext.agentBody ?? null,
        skillsSystemPromptSection: agentContext.skillsSystemPromptSection,
      });

      if (input.persistBake && input.bakeComposedSystemPrompt) {
        const expectedCurrentAgent = thread.currentAgent;
        const bakedSkillSlugs = modelInvocableSkillSlugs(agentContext.resolvedSkills);
        thread = await input.bakeComposedSystemPrompt(thread.id as ThreadId, {
          composedSystemPrompt: bakedPrompt,
          bakedSkillSlugs,
          expectedCurrentAgent,
        });
        if (
          !isThreadPromptFrozen(thread) ||
          thread.currentAgent !== expectedCurrentAgent ||
          thread.composedSystemPrompt !== bakedPrompt ||
          JSON.stringify(thread.bakedSkillSlugs ?? null) !== JSON.stringify(bakedSkillSlugs)
        ) {
          attempt += 1;
          if (attempt >= MAX_REBIND_BAKE_ATTEMPTS) {
            throw new Error("Failed to freeze thread prompt after concurrent agent rebinds");
          }
          continue;
        }
        tools = applyBakedInvokeAdvertisement({
          tools: agentContext.tools,
          bakedSkillSlugs: thread.bakedSkillSlugs,
          toolRegistry: input.toolRegistry,
        });
        systemPrompt = thread.composedSystemPrompt ?? bakedPrompt;
      } else {
        systemPrompt = bakedPrompt;
        thread = { ...thread, composedSystemPrompt: bakedPrompt };
        skillsSystemPromptSection = agentContext.skillsSystemPromptSection;
      }
    }

    const { messages, tools: contextTools } = buildContext({
      thread,
      turns: input.turns,
      blocks: input.blocks,
      tools,
      skillsSystemPromptSection,
      undoNotifications: input.undoNotifications,
      draftLifecycleEvents: input.draftLifecycleEvents,
    });

    const gatewayParams = agentContext.gatewayParams;

    return {
      thread,
      agentSlug: thread.currentAgent,
      resolvedSkills: agentContext.resolvedSkills,
      systemPrompt,
      tools: functionToolsFromAdvertised(contextTools),
      gatewayParams,
      baked,
      generateRequest: {
        messages,
        tools: contextTools,
        ...gatewayParams,
      },
    };
  }
}
