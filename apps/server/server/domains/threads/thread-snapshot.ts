/**
 * Thread snapshot builder: assembles the full ThreadSnapshotResponse (thread,
 * turns, blocks, model responses, event cursor) for an initial client load.
 * Owns the snapshot projection; depends inward on the thread repositories and event hub.
 * The envelope carries the snapshot sequence while liveState carries the
 * read-model projection cursor used to replay newer journaled deltas.
 */
import type { Block, JsonValue, ThreadSnapshotResponse, Turn } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  isThreadActionRequired,
  isVisibleConversationalTurn,
} from "./domain/visible-conversation-policy.js";
import { orderTurnsCausally } from "./order-turns.js";
import type {
  BlockRepository,
  ModelResponseRepository,
  ThreadRepository,
  ThreadStatusReader,
  TurnRepository,
} from "./ports/index.js";
import type { ThreadEventHub } from "./thread-event-hub.js";

export interface ThreadSnapshotRepositories {
  threads: ThreadRepository;
  turns: TurnRepository;
  blocks: BlockRepository;
  modelResponses: ModelResponseRepository;
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
  statusReader: ThreadStatusReader,
  threadId: ThreadId,
): Promise<ThreadSnapshotResponse> {
  const thread = await repos.threads.findById(threadId);
  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }
  const parentThread = thread.parentThreadId
    ? await repos.threads.findById(thread.parentThreadId as ThreadId)
    : null;

  // Liveness is the live lease's bound turn. Read it before the durable payload:
  // the lease only names a turn after its setup transaction committed, so a
  // turn named here is guaranteed to be in the `listByThread` projection below.
  const runningTurnId = await statusReader.readRunningTurnId(threadId);

  // Capture the head before any payload reads: the advertised sequence must
  // never be newer than the payload, or a client can accept a torn snapshot.
  const headSeq = await hub.headSeq(threadId);

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

  const nextSeq = (headSeq + 1n).toString();
  const resumeAfterSeq = (await hub.readModelProjectionWatermark(threadId)).toString();

  return {
    threadId,
    thread,
    parent: parentThread ? { id: parentThread.id, title: parentThread.title } : null,
    turns: threadTurns,
    liveState: {
      threadId,
      status: await statusReader.read(threadId),
      runningTurnId,
      // During an active run,
      // stream.delta rows can sit between that head and the last read-model
      // projection, so resume from the projection cursor and replay only the
      // unmaterialized delta window the snapshot could not include.
      resumeAfterSeq,
    },
    actionRequired: snapshotActionRequired(thread.activeLeafTurnId, threadTurns),
    nextSeq,
  };
}

function snapshotActionRequired(activeLeafTurnId: TurnId | null, turns: Turn[]): boolean {
  let turn = turns.find((candidate) => candidate.id === activeLeafTurnId);
  const visited = new Set<string>();
  while (turn && !visited.has(turn.id)) {
    visited.add(turn.id);
    if (
      isVisibleConversationalTurn({
        role: turn.role,
        metadata: turn.metadata ?? null,
        hasCustomBlock: turn.blocks.some((block) => block.blockType === "custom"),
      })
    ) {
      return isThreadActionRequired({ headRole: turn.role, headStatus: turn.status });
    }
    turn = turns.find((candidate) => candidate.id === turn?.prevTurnId);
  }
  return false;
}
