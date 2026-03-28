import type { ActivityBlockData } from "../types"

import { readTool, searchTool } from "./factories"
import { PACING_FIX_SCENARIO } from "./streaming-scenario"

import type { AssistantTurn, ThreadTurn, TurnBlock, UserTurn } from "@/features/threads"

const THREAD_ID = "thread-walkthrough"

function userTextBlock(id: string, sequence: number, text: string): TurnBlock {
  return {
    id,
    blockType: "text",
    sequence,
    textContent: text,
    status: "complete",
  }
}

function userReferenceBlock(id: string, sequence: number): TurnBlock {
  return {
    id,
    blockType: "reference",
    sequence,
    content: {
      ref_type: "file",
      ref_id: "chapters/chapter-19.md",
      title: "chapter-19.md",
      selection_start: 412,
      selection_end: 560,
    },
    status: "complete",
  }
}

function userTurn(
  id: string,
  parentId: string | null,
  createdAt: string,
  blocks: TurnBlock[],
  siblingIds: string[] = [id],
  siblingIndex = 0,
): UserTurn {
  return {
    id,
    threadId: THREAD_ID,
    parentId,
    role: "user",
    status: "complete",
    siblingIds,
    siblingIndex,
    createdAt: new Date(createdAt),
    blocks,
  }
}

function assistantHistoryTurn(
  id: string,
  parentId: string,
  createdAt: string,
  activity: ActivityBlockData,
): AssistantTurn {
  return {
    id,
    threadId: THREAD_ID,
    parentId,
    role: "assistant",
    status: "complete",
    siblingIds: [id],
    siblingIndex: 0,
    createdAt: new Date(createdAt),
    activity,
    model: "gpt-5.4-mini",
    inputTokens: 944,
    outputTokens: 511,
  }
}

const HISTORY_TURNS: ThreadTurn[] = [
  userTurn("turn-01", null, "2026-03-27T09:12:00.000Z", [
    userTextBlock(
      "turn-01-block-01",
      0,
      "Chapter 19 still feels abrupt after the sparring yard. Can you diagnose the pacing break and suggest a bridge paragraph?",
    ),
  ]),
  assistantHistoryTurn("turn-02", "turn-01", "2026-03-27T09:12:21.000Z", {
    id: "turn-02",
    isStreaming: false,
    items: [
      readTool("turn-02-tool-read", "chapters/chapter-19.md"),
      searchTool("turn-02-tool-search", "meditation bell"),
      {
        kind: "content",
        id: "turn-02-content",
        text: "The cut from the final strike to seated meditation is too sharp. A one-paragraph bridge using the bell motif would smooth the emotional drop.",
      },
    ],
  }),
  userTurn("turn-03", "turn-02", "2026-03-27T09:13:01.000Z", [
    userTextBlock(
      "turn-03-block-01",
      0,
      "Use this excerpt as the anchor. Keep Mara's voice restrained and avoid modern wording.",
    ),
    userReferenceBlock("turn-03-block-02", 1),
  ]),
  assistantHistoryTurn("turn-04", "turn-03", "2026-03-27T09:13:25.000Z", {
    id: "turn-04",
    isStreaming: false,
    items: [
      {
        kind: "content",
        id: "turn-04-content",
        text: "Understood. I'll produce a bridge with three beats: echo of steel, breath reset, then first bell strike.",
      },
    ],
  }),
  userTurn(
    "turn-05",
    "turn-04",
    "2026-03-27T09:13:47.000Z",
    [
      userTextBlock(
        "turn-05-block-01",
        0,
        "Great. Give me one polished paragraph now, and keep it between 90 and 120 words.",
      ),
    ],
    ["turn-05", "turn-05-sibling-alt"],
    0,
  ),
]

// Same streaming data as the Streaming Editor story — one scenario, two views.
const ACTIVE_TIMELINE = PACING_FIX_SCENARIO

export const THREAD_WALKTHROUGH_ACTIVE_TURN_ID = "turn-06"

export const THREAD_WALKTHROUGH = {
  threadId: THREAD_ID,
  history: HISTORY_TURNS,
  activeTimeline: ACTIVE_TIMELINE,
  activeTurnId: THREAD_WALKTHROUGH_ACTIVE_TURN_ID,
}
