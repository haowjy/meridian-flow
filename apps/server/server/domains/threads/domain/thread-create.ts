// @ts-nocheck
/**
 * Thread-creation normalization: validates and defaults CreateThreadInput into a
 * NormalizedThreadCreate (kind, title, spawn metadata, ...). Domain logic shared
 * by every repository adapter so creation semantics stay identical across them.
 */
import type { SpawnStatus, ThreadKind } from "@meridian/contracts/threads";
import type { CreateThreadInput } from "../ports/repositories.js";

export interface NormalizedThreadCreate {
  kind: ThreadKind;
  title: string;
  /** Raw system prompt at creation; bake output lives in `composedSystemPrompt` only. */
  systemPrompt: string | null;
  currentAgent: string | null;
  parentThreadId: string | null;
  spawnStatus: SpawnStatus | null;
  spawnDepth: number;
}

/** Phase 1 only supports root (primary) thread creation; spawn/fork fields are rejected. */
export class ThreadLifecycleNotSupportedError extends Error {
  constructor(detail: string) {
    super(`Thread spawn/fork lifecycle is not supported yet: ${detail}`);
    this.name = "ThreadLifecycleNotSupportedError";
  }
}

function rejectNonRootLifecycle(detail: string): never {
  throw new ThreadLifecycleNotSupportedError(detail);
}

/**
 * Validates and normalizes thread creation input.
 * Phase 1: only root threads — primary kind with no parent or spawn fields.
 */
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
    systemPrompt: input.systemPrompt ?? null,
    currentAgent: input.currentAgent ?? null,
    parentThreadId: null,
    spawnStatus: null,
    spawnDepth: 0,
  };
}
