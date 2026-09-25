import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { filterVisibleTurns } from "./visible-chat-turns";

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

describe("filterVisibleTurns", () => {
  it("keeps queued inbox messages visible until adoption, then hides them for inline placement", () => {
    const turn = userTurn("message-1", { kind: "inbox_message" });

    expect(filterVisibleTurns([turn], new Map([[turn.id, "queued"]]))).toEqual([turn]);
    expect(filterVisibleTurns([turn], new Map())).toEqual([]);
  });
});
