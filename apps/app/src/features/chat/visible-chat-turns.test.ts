import type { Block, Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { filterVisibleTurns, isVisibleChatTurn } from "./visible-chat-turns";

function userTurn(id: string, metadata: Turn["metadata"]): Turn {
  return {
    id,
    threadId: "thread-1",
    prevTurnId: null,
    role: "user",
    status: "complete",
    metadata,
    blocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Turn;
}

function systemTurn(id: string, metadata: Turn["metadata"], blocks: Block[] = []): Turn {
  return {
    id,
    threadId: "thread-1",
    prevTurnId: null,
    role: "system",
    status: "complete",
    metadata,
    blocks,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Turn;
}

function textBlock(id: string, turnId: string, text: string): Block {
  return {
    id,
    turnId,
    responseId: null,
    blockType: "text",
    sequence: 0,
    textContent: text,
    content: text,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Block;
}

describe("filterVisibleTurns", () => {
  it("keeps queued inbox messages visible until adoption, then hides them for inline placement", () => {
    const turn = userTurn("message-1", { kind: "inbox_message" });

    expect(filterVisibleTurns([turn], new Map([[turn.id, "queued"]]))).toEqual([turn]);
    expect(filterVisibleTurns([turn], new Map())).toEqual([]);
  });

  it("hides a hidden skill-body turn: it carries no custom block, so it never reaches the transcript", () => {
    // `persistSkillBodies` (orchestrator.ts) chains this turn right after the
    // writer's own turn instead of adding a block to it, specifically so the
    // body never renders in the writer's own bubble (`UserTurn.tsx`'s
    // `projectUserTurn` concatenates every text block of a user turn).
    const turn = systemTurn("skill-body-1", { kind: "system_update", section: "skill_body" }, [
      textBlock("b1", "skill-body-1", "<system_update>\nskill invoked: craft\n</system_update>"),
    ]);

    expect(isVisibleChatTurn(turn)).toBe(false);
    expect(filterVisibleTurns([turn])).toEqual([]);
  });

  it("hides a hidden notices turn the same way", () => {
    const turn = systemTurn("notices-1", { kind: "system_update", section: "notices" }, [
      textBlock("b1", "notices-1", "<system_update>\nAn undo notice.\n</system_update>"),
    ]);

    expect(isVisibleChatTurn(turn)).toBe(false);
  });
});
