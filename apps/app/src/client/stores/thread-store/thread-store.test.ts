import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { createThreadStore } from "./thread-store";

function setup() {
  return createThreadStore({
    now: 0,
    threadCache: {
      upsertThread() {},
      patchThread() {},
      invalidateThread() {},
      invalidateThreadSnapshot() {},
    },
  });
}

function customBlock(props: Record<string, JsonValue>): Block {
  return {
    id: "card-1",
    turnId: "turn-1",
    responseId: null,
    blockType: "custom",
    sequence: 4,
    content: { kind: "helper-result", props },
    status: "complete",
    textContent: null,
    createdAt: "2026-09-23T00:00:00.000Z",
  };
}

describe("durable block wire freshness", () => {
  it("keeps the cursor and snapshot floor monotonic beyond safe integers", () => {
    const store = setup();
    const actions = store.getState();
    const seq = "9007199254740993000";
    expect(actions.acceptDurableBlockSeq("thread-1", seq)).toBe(true);
    expect(actions.acceptDurableBlockSeq("thread-1", seq)).toBe(false);
    expect(actions.acceptDurableBlockSeq("thread-1", "9007199254740992999")).toBe(false);
    expect(actions.acceptDurableBlockSeq("thread-1", "invalid")).toBe(false);
    expect(actions.acceptsThreadSnapshot("thread-1", seq)).toBe(false);
    expect(actions.acceptsThreadSnapshot("thread-1", "9007199254740993001")).toBe(true);
  });

  it("does not let a stale snapshot alter lifecycle or terminal blocks", () => {
    const store = setup();
    const actions = store.getState();
    actions.ensureAssistantTurn("thread-1", "turn-1");
    actions.upsertAssistantBlock("thread-1", "turn-1", customBlock({ outcome: "done" }));
    const before = actions.turns("thread-1");
    actions.acceptDurableBlockSeq("thread-1", "375000");
    const accepted = actions.applyThreadSnapshot(
      { id: "thread-1", projectId: "project-1" } as never,
      [],
      { nextSeq: "375000", lifecycle: { actionRequired: false, runningTurnId: null } },
    );
    expect(accepted).toBe(false);
    expect(actions.turns("thread-1")).toBe(before);
    expect(store.getState().durableBlockCursorByThread["thread-1"]).toBe("375000");
  });
});

it("keeps a failed optimistic writer row local instead of invalidating server truth", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { createThreadCache } = await import("./thread-cache");
  const client = new QueryClient();
  const key = ["threads", "thread-1", "snapshot"];
  client.setQueryData(key, { turns: [] });
  const store = createThreadStore({ now: 0, threadCache: createThreadCache(client) });
  const row = store.getState().appendUserTurn("thread-1", [{ type: "text", text: "Keep it" }]);
  store.getState().patchTurnStatus("thread-1", row.id, "error");
  await Promise.resolve();
  expect(store.getState().turns("thread-1")?.[0]?.status).toBe("error");
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
});

it("a thread upsert inserts a new list row with its mode but never rewrites an existing row's mode", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const { createThreadCache } = await import("./thread-cache");
  const client = new QueryClient();
  const key = ["projects", "project-1", "threads"];
  const thread = {
    id: "thread-1",
    projectId: "project-1",
    aiWriteMode: "direct",
    effectiveAiWriteMode: "direct",
  } as never;
  const cache = createThreadCache(client);
  type Row = { aiWriteMode: string; effectiveAiWriteMode: string };
  const row = () => client.getQueryData<Row[]>(key)?.[0];
  cache.upsertThread(thread);
  expect([row()?.aiWriteMode, row()?.effectiveAiWriteMode]).toEqual(["direct", "direct"]);
  // The list's own refetch owns both fields: an older snapshot's modes must not replace them.
  cache.upsertThread({
    ...(thread as object),
    aiWriteMode: "draft",
    effectiveAiWriteMode: "draft",
  } as never);
  expect([row()?.aiWriteMode, row()?.effectiveAiWriteMode]).toEqual(["direct", "direct"]);
});
