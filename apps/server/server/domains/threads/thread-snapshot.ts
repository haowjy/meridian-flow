/**
 * Thread snapshot builder: assembles the full ThreadSnapshotResponse (thread,
 * turns, blocks, model responses, event cursor) for an initial client load.
 * Owns the snapshot projection; depends inward on the thread repositories and event hub.
 * Key decision: liveState carries both the current stream head (`nextSeq`) and
 * the read-model projection cursor (`resumeAfterSeq`) because journaled deltas
 * can be newer than the rows this snapshot reads.
 */
import type { Block, JsonValue, ThreadSnapshotResponse, Turn } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import { isWaitingForUser } from "./domain/thread-list-projection.js";
import { orderTurnsCausally } from "./order-turns.js";
import type {
  BlockRepository,
  ModelResponseRepository,
  ThreadRepository,
  TurnRepository,
} from "./ports/index.js";
import type { ThreadEventHub } from "./thread-event-hub.js";

export interface ThreadSnapshotRepositories {
  threads: ThreadRepository;
  turns: TurnRepository;
  blocks: BlockRepository;
  modelResponses: ModelResponseRepository;
}

export interface RunningTurnQuery {
  getRunningTurnId(threadId: ThreadId): TurnId | null;
}

function isObjectContent(content: JsonValue): content is Record<string, JsonValue> {
  return typeof content === "object" && content !== null && !Array.isArray(content);
}

export function toClientSafeBlock(block: Block): Block {
  if (block.blockType !== "reasoning" && block.blockType !== "thinking") {
    return block;
  }

  if (!isObjectContent(block.content) || !("providerOptions" in block.content)) {
    return block;
  }

  const { providerOptions: _providerOptions, ...content } = block.content;
  return {
    ...block,
    content,
  };
}

function siblingIdsFor(turn: Turn, turns: Turn[]): string[] {
  return turns.filter((candidate) => candidate.prevTurnId === turn.prevTurnId).map((t) => t.id);
}

export async function buildThreadSnapshot(
  repos: ThreadSnapshotRepositories,
  hub: ThreadEventHub,
  runner: RunningTurnQuery,
  threadId: ThreadId,
): Promise<ThreadSnapshotResponse> {
  const thread = await repos.threads.findById(threadId);
  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  // Capture liveness BEFORE reading the durable turn list (ordering matters — see below).
  const runnerTurnId = runner.getRunningTurnId(threadId);

  const turns = orderTurnsCausally(await repos.turns.listByThread(threadId));
  const threadTurns = await Promise.all(
    turns.map(async (turn): Promise<Turn> => {
      const blocks = (await repos.blocks.listByTurn(turn.id)).map(toClientSafeBlock);
      const responses = await repos.modelResponses.listByTurn(turn.id);
      return {
        ...turn,
        blocks,
        responses,
        siblingIds: siblingIdsFor(turn, turns),
      };
    }),
  );

  const headSeq = await hub.headSeq(threadId);
  const nextSeq = (headSeq + 1n).toString();
  const resumeAfterSeq = (await hub.readModelProjectionWatermark(threadId)).toString();
  const headTurn = thread.activeLeafTurnId
    ? (turns.find((turn) => turn.id === thread.activeLeafTurnId) ?? null)
    : null;
  // runningTurnId is liveness; durable turn status is its single source of truth.
  // (1) The runner map is cleared lazily (only in the generator's finally) and NOT by
  //     finalizeError, so it can still name a turn that already reached a terminal
  //     durable status — advertise a running turn only when the durable turn exists
  //     AND is non-terminal.
  // (2) runnerTurnId is captured above, before the turn-list read: the runner publishes
  //     the id only after runTurn's setup transaction commits the assistant turn row
  //     (persistAndAppendEvents projects it in-transaction), so reading the id first
  //     guarantees this listByThread already includes that turn. This closes the
  //     turn-start race where a stale list would drop a genuinely-active turn.
  const runningTurn = runnerTurnId
    ? threadTurns.find((turn) => turn.id === runnerTurnId)
    : undefined;
  const runningTurnId =
    runningTurn && !isTerminalTurnStatus(runningTurn.status) ? runningTurn.id : null;

  return {
    threadId,
    thread,
    turns: threadTurns,
    liveState: {
      threadId,
      status: thread.status,
      runningTurnId,
      currentAgent: thread.currentAgent,
      nextSeq,
      // `nextSeq` is the live journal/AG-UI head + 1. During an active run,
      // stream.delta rows can sit between that head and the last read-model
      // projection, so resume from the projection cursor and replay only the
      // unmaterialized delta window the snapshot could not include.
      resumeAfterSeq,
    },
    waitingForUser: isWaitingForUser(
      thread.status,
      headTurn?.role ?? null,
      headTurn?.status ?? null,
    ),
    nextSeq,
  };
}
