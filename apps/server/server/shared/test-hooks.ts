const TEST_HOOK_POINTS = [
  "treeList.afterLock",
  "treeList.afterAppend",
  "treeList.afterLiveRows",
  "treeList.afterRows",
  "treeList.afterCommit",
  "inverse.afterCaptureRead",
  "inverse.beforeCommitScope",
  "command.beforeClaim",
  "command.afterClaim",
  "command.afterLock",
  "command.beforeCommit",
  "command.afterCommit",
  "recovery.beforeResolve",
  "response.beforeStore",
  "block.beforeStore",
  "block.duringStore",
  "block.afterStore",
  "ask.pending",
  "ask.answer.afterCommit",
] as const;
export type TestHookPoint = (typeof TEST_HOOK_POINTS)[number];

export function isTestHookPoint(point: string): point is TestHookPoint {
  return (TEST_HOOK_POINTS as readonly string[]).includes(point);
}

const hooks = new Map<TestHookPoint, () => Promise<void>>();

export function setTestHook(point: TestHookPoint, hook: () => Promise<void>): () => void {
  hooks.set(point, hook);
  return () => {
    if (hooks.get(point) === hook) hooks.delete(point);
  };
}

export async function testHook(point: TestHookPoint): Promise<void> {
  await hooks.get(point)?.();
}
