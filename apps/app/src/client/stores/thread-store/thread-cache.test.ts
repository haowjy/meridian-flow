import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { createThreadCache } from "./thread-cache";

const PROJECT = "project-1";
const OTHER_PROJECT = "project-2";
const THREAD = "thread-1";

function seed(client: QueryClient, queryKey: readonly unknown[]) {
  client.setQueryData(queryKey, {});
}

function isInvalidated(client: QueryClient, queryKey: readonly unknown[]): boolean {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  if (!query) throw new Error(`query not seeded: ${JSON.stringify(queryKey)}`);
  return query.state.isInvalidated;
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe("invalidateThread", () => {
  it("invalidates the project's context trees on a terminal turn", async () => {
    const client = new QueryClient({});
    const manuscriptTree = projectQueryKeys.contextTree(PROJECT, "manuscript");
    const kbTree = projectQueryKeys.contextTree(PROJECT, "kb");
    const workScopedTree = projectQueryKeys.contextTree(PROJECT, "scratch", "work-1");
    const otherProjectTree = projectQueryKeys.contextTree(OTHER_PROJECT, "manuscript");
    const contextReadNamedTree = [
      "projects",
      PROJECT,
      "context",
      "manuscript",
      "read",
      "tree",
    ] as const;
    for (const key of [
      manuscriptTree,
      kbTree,
      workScopedTree,
      otherProjectTree,
      contextReadNamedTree,
    ]) {
      seed(client, key);
    }
    seed(client, threadQueryKeys.snapshot(THREAD));

    createThreadCache(client).invalidateThread(THREAD, PROJECT);
    await flushMicrotasks();

    expect(isInvalidated(client, manuscriptTree)).toBe(true);
    expect(isInvalidated(client, kbTree)).toBe(true);
    expect(isInvalidated(client, workScopedTree)).toBe(true);
    expect(isInvalidated(client, otherProjectTree)).toBe(false);
    expect(isInvalidated(client, contextReadNamedTree)).toBe(false);
    expect(isInvalidated(client, threadQueryKeys.snapshot(THREAD))).toBe(true);
  });

  it("leaves context trees alone when the owning project is unknown", async () => {
    const client = new QueryClient({});
    const tree = projectQueryKeys.contextTree(PROJECT, "manuscript");
    seed(client, tree);
    seed(client, threadQueryKeys.snapshot(THREAD));

    createThreadCache(client).invalidateThread(THREAD, null);
    await flushMicrotasks();

    expect(isInvalidated(client, tree)).toBe(false);
    expect(isInvalidated(client, threadQueryKeys.snapshot(THREAD))).toBe(true);
  });
});
