import type { AgentPermission } from "@meridian/contracts/agents";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { BlockUpsertedRow, Turn } from "@meridian/contracts/threads";
import {
  type AiWriteMode,
  isWorkArchived,
  type Work,
  workLifecycleState,
} from "@meridian/contracts/works";
import type { WorkRepository } from "../../projects/index.js";
import { type ThreadWorksRepository, writeModeSwitchMetadata } from "../../threads/index.js";
import { contentForBlockInput } from "./block-helpers.js";
import { createLocalTurn } from "./local-turn.js";
import { mayChangeWorks } from "./permissions/action-policy.js";
import { describeWriteMode } from "./work-context.js";

export interface WriteModeSwitchPort {
  renderNotice(threadId: ThreadId, mode: AiWriteMode): Promise<string>;
  setWorkDefault(workId: WorkId, mode: AiWriteMode): Promise<void>;
}

export function writeModeSwitchNotice(
  work: Pick<Work, "archivedAt" | "isNoWork">,
  mode: AiWriteMode,
  mayUnarchive: boolean,
): string {
  const modeText = describeWriteMode({
    mode,
    archived: isWorkArchived(work),
    mayUnarchive,
    noWork: work.isNoWork,
  }).instructions.join(" ");
  return mode === "direct"
    ? `The writer switched this chat to auto-apply. ${modeText} Drafts you already wrote stay for the writer to review.`
    : `The writer switched this chat to draft mode. ${modeText}`;
}

export function createWriteModeSwitchPort(deps: {
  works: Pick<WorkRepository, "findById" | "setDefaultAiWriteMode">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary">;
  readChainPermission(threadId: ThreadId): Promise<AgentPermission>;
}): WriteModeSwitchPort {
  return {
    async renderNotice(threadId, mode) {
      const primary = await deps.threadWorks.findPrimary(threadId);
      const work = primary ? await deps.works.findById(primary.workId) : null;
      if (!work || workLifecycleState(work) === "deleted")
        throw new Error(`Thread primary Work is unavailable: ${threadId}`);
      return writeModeSwitchNotice(
        work,
        mode,
        mayChangeWorks(await deps.readChainPermission(threadId)),
      );
    },
    setWorkDefault: (workId, mode) => deps.works.setDefaultAiWriteMode(workId, mode),
  };
}

export function writeModeSwitchTurn(input: {
  threadId: ThreadId;
  prevTurnId: TurnId | null;
  position: number;
  mode: AiWriteMode;
  controlMessageId: string;
  notice: string;
}): { turn: Turn; block: BlockUpsertedRow } {
  const turn = {
    ...createLocalTurn({
      threadId: input.threadId,
      position: input.position,
      prevTurnId: input.prevTurnId,
      role: "system",
      origin: "system",
      status: "complete",
      writeMode: input.mode,
      metadata: writeModeSwitchMetadata({
        mode: input.mode,
        controlMessageId: input.controlMessageId,
      }),
    }),
    completedAt: new Date().toISOString(),
  };
  const block = contentForBlockInput({
    id: turn.id,
    turnId: turn.id,
    blockType: "text",
    textContent: `<system_update>\n${input.notice}\n</system_update>`,
    sequence: 0,
    status: "complete",
  });
  return { turn, block };
}
