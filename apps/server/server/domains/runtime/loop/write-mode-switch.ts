/**
 * The applied write-mode switch: its model-facing notice and the Work-side
 * collaborators the switch commands need. The switch turn owns no document
 * edits, so it has no change trail, receipt or undo candidate.
 */
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
import {
  isWriteModeSwitchTurn,
  type ThreadWorksRepository,
  type TurnRepository,
  writeModeSwitchMetadata,
} from "../../threads/index.js";
import { contentForBlockInput } from "./block-helpers.js";
import { createLocalTurn } from "./local-turn.js";
import { mayChangeWorks } from "./permissions/action-policy.js";
import { describeWriteMode } from "./work-context.js";

export interface WriteModeSwitchPort {
  /** The notice body for the chat's new mode, rendered against its bound Work. */
  renderNotice(threadId: ThreadId, mode: AiWriteMode): Promise<string>;
  /** Decision 3: the writer's latest choice becomes the Work's default for new chats. */
  setWorkDefault(workId: WorkId, mode: AiWriteMode): Promise<void>;
}

/** One sentence, then the same instructions the Work context gives for that mode. */
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

/** The durable switch turn chained at the active leaf, with its notice block. */
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

/** The turn behind any trailing switch turns: a switch applied after a failed reply must not take Retry away. */
export async function pastTrailingSwitches(
  turns: Pick<TurnRepository, "findById">,
  turn: Turn,
): Promise<Turn | null> {
  let current: Turn | null = turn;
  while (current && isWriteModeSwitchTurn(current) && current.prevTurnId)
    current = await turns.findById(current.prevTurnId as TurnId);
  return current;
}
