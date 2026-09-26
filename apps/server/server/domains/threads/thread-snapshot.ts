/**
 * Thread snapshot builder: assembles the full ThreadSnapshotResponse (thread,
 * turns, blocks, model responses, event cursor) for an initial client load.
 * Owns the snapshot projection; depends inward on the thread repositories and event hub.
 * The envelope carries the snapshot sequence while liveState carries the
 * read-model projection cursor used to replay newer journaled deltas.
 */
import type { Block, JsonValue, ThreadSnapshotResponse, Turn } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { readThreadActivity } from "./domain/thread-activity.js";
import {
  isThreadActionRequired,
  isVisibleConversationalTurn,
} from "./domain/visible-conversation-policy.js";
import { orderTurnsCausally } from "./order-turns.js";
import type {
  BlockRepository,
  ModelResponseRepository,
  ThreadLiveReaders,
  ThreadRepositories,
  ThreadRepository,
  TurnRepository,
} from "./ports/index.js";
import type { ThreadEventHub } from "./thread-event-hub.js";

export interface ThreadSnapshotRepositories extends Pick<ThreadRepositories, "readSnapshot"> {
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

function groupBy<T, K>(items: T[], keyFor: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export async function buildThreadSnapshot(
  repos: ThreadSnapshotRepositories,
  hub: ThreadEventHub,
  statusReader: ThreadLiveReaders,
  threadId: ThreadId,
): Promise<ThreadSnapshotResponse> {
  return repos.readSnapshot(async () => {
    const thread = await repos.threads.findById(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const parentThread = thread.parentThreadId
      ? await repos.threads.findById(thread.parentThreadId as ThreadId)
      : null;

    const runningTurnId = await statusReader.readRunningTurnId(threadId);
    const headSeq = await hub.headSeq(threadId);

    const turns = orderTurnsCausally(await repos.turns.listByThread(threadId));
    const blocksByTurn = groupBy(
      (await repos.blocks.listByThread(threadId))
        .filter((block) => block.pruned !== true)
        .map(toClientSafeBlock),
      (block) => block.turnId,
    );
    const responsesByTurn = groupBy(
      await repos.modelResponses.listByThread(threadId),
      (response) => response.turnId,
    );
    const siblings = groupBy(turns, (turn) => turn.prevTurnId);
    const siblingIds = new Map(
      [...siblings].map(([parent, children]) => [parent, children.map((turn) => turn.id)]),
    );
    const threadTurns = turns.map(
      (turn): Turn => ({
        ...turn,
        blocks: blocksByTurn.get(turn.id) ?? [],
        responses: responsesByTurn.get(turn.id) ?? [],
        siblingIds: siblingIds.get(turn.prevTurnId) as string[],
      }),
    );

    const nextSeq = (headSeq + 1n).toString();
    const resumeAfterSeq = (await hub.readModelProjectionWatermark(threadId)).toString();
    const activity = await readThreadActivity({ threads: repos.threads, statusReader }, threadId);
    const pending = await statusReader.readPending(threadId);

    return {
      threadId,
      thread,
      parent: parentThread ? { id: parentThread.id, title: parentThread.title } : null,
      turns: threadTurns,
      liveState: {
        threadId,
        status: await statusReader.read(threadId),
        runningTurnId,
        activity,
        pending,
        // During an active run,
        // stream.delta rows can sit between that head and the last read-model
        // projection, so resume from the projection cursor and replay only the
        // unmaterialized delta window the snapshot could not include.
        resumeAfterSeq,
      },
      actionRequired: snapshotActionRequired(thread.activeLeafTurnId, threadTurns),
      nextSeq,
    };
  });
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
