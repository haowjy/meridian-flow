// @ts-nocheck
/**
 * Purpose: Verifies shared golden AG-UI streams reduce into canonical store
 * turns. This catches drift between server projector fixtures and the frontend
 * event-to-store mapper.
 */

import {
  GOLDEN_ASSISTANT_TURN_ID,
  GOLDEN_THREAD_ID,
  GOLDEN_TOOL_ASSISTANT_TURN_ID,
  GOLDEN_TOOL_CALL_ID,
  SIMPLE_TEXT_TURN_AGUI,
  SIMPLE_TOOL_TURN_AGUI,
} from "@meridian/contracts/threads";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createThreadStore } from "@/client/stores/thread-store/thread-store";

import { applyAguiEventToStore } from "./reduce-turn-event";

function foldAguiStream(events: typeof SIMPLE_TEXT_TURN_AGUI, threadId: string) {
  const store = createThreadStore({ now: Date.now(), queryClient: new QueryClient() });
  for (const event of events) {
    applyAguiEventToStore(store.getState(), threadId, event);
  }
  return store.getState().turns(threadId)?.at(-1);
}

describe("orchestrator → AG-UI → thread store (golden)", () => {
  it("folds simple text turn AG-UI stream to completed store turn", () => {
    const turn = foldAguiStream(SIMPLE_TEXT_TURN_AGUI, GOLDEN_THREAD_ID);

    expect(turn?.id).toBe(GOLDEN_ASSISTANT_TURN_ID);
    expect(turn?.status).toBe("complete");
    expect(turn?.error).toBeNull();
    const lastTextBlock = [...(turn?.blocks ?? [])].reverse().find((b) => b.blockType === "text");
    expect(lastTextBlock?.textContent).toBe("Hello world");
    expect(lastTextBlock?.status).toBe("complete");
  });

  it("folds simple tool turn AG-UI stream with tool activity and completion", () => {
    const turn = foldAguiStream(SIMPLE_TOOL_TURN_AGUI, GOLDEN_THREAD_ID);

    expect(turn?.id).toBe(GOLDEN_TOOL_ASSISTANT_TURN_ID);
    expect(turn?.status).toBe("complete");
    const toolBlock = turn?.blocks.find((block) => block.blockType === "tool_use");
    expect(toolBlock?.id).toBe(`tool-${GOLDEN_TOOL_CALL_ID}`);
    expect(toolBlock?.status).toBe("complete");
    expect(toolBlock?.content).toMatchObject({
      toolName: "read_file",
      output: "file contents",
    });
  });
});
