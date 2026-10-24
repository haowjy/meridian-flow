/**
 * Thread store behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - list reads own existing thread write mode
 */
import { expect, it } from "vitest";
import { createThreadStore } from "./thread-store";

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
