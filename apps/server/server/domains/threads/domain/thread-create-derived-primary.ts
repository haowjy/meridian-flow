import { type DraftId, newDraftId } from "@meridian/contracts";
import type {
  ProjectId,
  PromptBakeId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type { Thread, ThreadOriginType, ThreadOverrides } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import { toIsoString } from "./contract-serialization.js";

export interface CreateDerivedPrimaryThreadInput {
  id: ThreadId;
  userId: UserId;
  projectId: ProjectId;
  workId: WorkId | null;
  aiWriteMode: AiWriteMode;
  source: Pick<Thread, "parentThreadId" | "rootThreadId" | "spawnDepth" | "draftId">;
  originType: Extract<ThreadOriginType, "handoff" | "fork">;
  draftId?: DraftId;
  originTurnId?: TurnId | null;
  overrides: ThreadOverrides;
  title?: string | null;
  initialPromptBakeId?: PromptBakeId | null;
}

export function buildDerivedPrimaryThreadRow(input: CreateDerivedPrimaryThreadInput): Thread {
  const now = toIsoString(new Date());
  return {
    id: input.id,
    projectId: input.projectId,
    workId: input.workId,
    aiWriteMode: input.aiWriteMode,
    effectiveAiWriteMode: input.aiWriteMode,
    userId: input.userId,
    kind: "primary",
    title: input.title ?? null,
    ref: null,
    initialPromptBakeId: input.initialPromptBakeId ?? null,
    agentDefinitionRevisionId: null,
    agentName: null,
    overrides: input.overrides,
    nextSeq: "0",
    activeLeafTurnId: null,
    parentThreadId: input.source.parentThreadId,
    originType: input.originType,
    originTurnId: input.originTurnId ?? null,
    rootThreadId: input.originType === "handoff" ? input.id : input.source.rootThreadId,
    draftId:
      input.originType === "handoff" ? (input.draftId ?? newDraftId()) : input.source.draftId,
    spawnDepth: input.source.spawnDepth,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    deletedAt: null,
  };
}
