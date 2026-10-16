/** Stored chat identity and its HTTP response validator. Run state lives on the live record. */
import { z } from "zod";
import { aiWriteModeSchema } from "../works/ai-write-mode.js";

export const threadSchema = z.object({
  id: z.string().min(1),
  /** Project this thread belongs to. */
  projectId: z.string().min(1),
  /** Work item this thread belongs to; null when ungrouped. */
  workId: z.string().nullable(),
  /** The chat's own write mode, copied at creation from the request or its Work's default. */
  aiWriteMode: aiWriteModeSchema,
  /** The mode the chat writes in next: a queued mode switch's mode, else `aiWriteMode`. */
  effectiveAiWriteMode: aiWriteModeSchema,
  userId: z.string().min(1),
  kind: z.enum(["primary", "subagent"]),
  status: z.enum(["idle", "archived"]),
  title: z.string().nullable(),
  /** Server-assigned handle: `cN` for primaries, `pN` for subagents; null before persist. */
  ref: z.string().nullable(),
  /** First immutable bake for this thread; null until the first request is assembled. */
  initialPromptBakeId: z.string().nullable(),
  agentDefinitionRevisionId: z.string().nullable(),
  /** Display name from the retained Agent definition. */
  agentName: z.string().nullable(),
  nextSeq: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .optional(),
  /** Canonical logical head of the active conversation branch. */
  activeLeafTurnId: z.string().nullable(),
  /**
   * Spawn-tree parent: null for a root, the spawning thread for a subagent.
   * A fork/handoff derivation is a SIBLING of its source, not the source's
   * child, so it takes the source's own `parentThreadId` (null when the
   * source is itself a root) rather than pointing at the source.
   */
  parentThreadId: z.string().nullable(),
  /** Set when this thread was derived via handoff or fork. */
  originType: z.enum(["spawn", "handoff", "fork"]).nullable().optional(),
  /**
   * Fork/handoff anchor turn on the SOURCE thread (not necessarily
   * `parentThreadId`); resolving its owning thread recovers the fork-source
   * edge, since `parentThreadId` never carries it.
   */
  originTurnId: z.string().nullable().optional(),
  /**
   * Identifies the run tree this thread belongs to. An organic root equals its
   * own id; a subagent takes its spawning parent's root; a fork/handoff
   * derivation takes its SOURCE's root (sharing lineage with it instead of
   * starting a new tree). Used for run-scoped project workspace paths such as
   * `runs/<rootThreadId>/input/…`.
   */
  rootThreadId: z.string().min(1),
  spawnDepth: z.number().int().nonnegative(),
  spawnStatus: z.enum(["running", "succeeded", "failed", "cancelled"]).nullable(),
  totalCostUsd: z.string(),
  turnCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string(),
  deletedAt: z.string().nullable(),
});

export type Thread = z.infer<typeof threadSchema>;
