import type { SpawnStatus, ThreadKind } from "@meridian/contracts/threads";
import type { CreateThreadInput } from "../ports/repositories.js";

export interface NormalizedThreadCreate {
  kind: ThreadKind;
  title: string;
  parentThreadId: string | null;
  spawnStatus: SpawnStatus | null;
  spawnDepth: number;
}

export class ThreadLifecycleNotSupportedError extends Error {
  constructor(detail: string) {
    super(`Thread spawn/fork lifecycle is not supported yet: ${detail}`);
    this.name = "ThreadLifecycleNotSupportedError";
  }
}

function rejectNonRootLifecycle(detail: string): never {
  throw new ThreadLifecycleNotSupportedError(detail);
}

export function normalizeThreadCreate(input: CreateThreadInput): NormalizedThreadCreate {
  if (input.kind !== undefined && input.kind !== "primary") {
    rejectNonRootLifecycle(`kind "${input.kind}" is not supported`);
  }
  if (input.parentThreadId) {
    rejectNonRootLifecycle("parentThreadId is not supported");
  }
  if (input.spawnStatus) {
    rejectNonRootLifecycle("spawnStatus is not supported");
  }
  if (input.spawnDepth !== undefined && input.spawnDepth > 0) {
    rejectNonRootLifecycle("spawnDepth > 0 is not supported");
  }

  return {
    kind: "primary",
    title: input.title ?? "",
    parentThreadId: null,
    spawnStatus: null,
    spawnDepth: 0,
  };
}
