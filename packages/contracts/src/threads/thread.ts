/** Stored chat identity and its HTTP response validator. Run state lives on the live record. */
import { z } from "zod";
import type { PromptBakeId } from "../runtime/ids.js";
import { type AiWriteMode, aiWriteModeSchema } from "../works/ai-write-mode.js";
import type { SpawnStatus, ThreadKind, ThreadLifecycleStatus, ThreadOriginType } from "./index.js";

export interface Thread {
  id: string;
  /** Project this thread belongs to. */
  projectId: string;
  /** Work item this thread belongs to; null when ungrouped. */
  workId: string | null;
  /** The chat's own write mode, copied at creation from the request or its Work's default. */
  aiWriteMode: AiWriteMode;
  /** The mode the chat writes in next: a queued mode switch's mode, else `aiWriteMode`. */
  effectiveAiWriteMode: AiWriteMode;
  userId: string;
  kind: ThreadKind;
  status: ThreadLifecycleStatus;
  title: string | null;
  /** Server-assigned handle: `cN` for primaries, `pN` for subagents; null before persist. */
  ref: string | null;
  /** First immutable bake for this thread; null until the first request is assembled. */
  initialPromptBakeId: PromptBakeId | null;
  agentDefinitionRevisionId: string | null;
  /** Display name from the retained Agent definition. */
  agentName: string | null;
  nextSeq?: string;
  /** Canonical logical head of the active conversation branch. */
  activeLeafTurnId: string | null;
  /**
   * Spawn-tree parent: null for a root, the spawning thread for a subagent.
   * A fork/handoff derivation is a SIBLING of its source, not the source's
   * child, so it takes the source's own `parentThreadId` (null when the
   * source is itself a root) rather than pointing at the source.
   */
  parentThreadId: string | null;
  /** Set when this thread was derived via handoff or fork. */
  originType?: ThreadOriginType | null;
  /**
   * Fork/handoff anchor turn on the SOURCE thread (not necessarily
   * `parentThreadId`); resolving its owning thread recovers the fork-source
   * edge, since `parentThreadId` never carries it.
   */
  originTurnId?: string | null;
  /**
   * Identifies the run tree this thread belongs to. An organic root equals its
   * own id; a subagent takes its spawning parent's root; a fork/handoff
   * derivation takes its SOURCE's root (sharing lineage with it instead of
   * starting a new tree). Used for run-scoped project workspace paths such as
   * `runs/<rootThreadId>/input/…`.
   */
  rootThreadId: string;
  spawnDepth: number;
  spawnStatus: SpawnStatus | null;
  totalCostUsd: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  deletedAt: string | null;
}

export const threadSchema = z.looseObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  workId: z.string().nullable(),
  aiWriteMode: aiWriteModeSchema,
  effectiveAiWriteMode: aiWriteModeSchema,
  userId: z.string().min(1),
  kind: z.enum(["primary", "subagent"]),
  status: z.enum(["idle", "archived"]),
  title: z.string().nullable(),
  ref: z.string().nullable(),
  initialPromptBakeId: z.string().nullable(),
  agentDefinitionRevisionId: z.string().nullable(),
  agentName: z.string().nullable(),
  nextSeq: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .optional(),
  activeLeafTurnId: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  originType: z.enum(["spawn", "handoff", "fork"]).nullable().optional(),
  originTurnId: z.string().nullable().optional(),
  rootThreadId: z.string().min(1),
  spawnDepth: z.number().int().nonnegative(),
  spawnStatus: z.enum(["running", "succeeded", "failed", "cancelled"]).nullable(),
  totalCostUsd: z.string(),
  turnCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string(),
  deletedAt: z.string().nullable(),
}) satisfies z.ZodType<Thread>;
