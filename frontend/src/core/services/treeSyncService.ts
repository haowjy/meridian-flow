import { db } from "@/core/lib/db";
import type {
  PendingTreeOp,
  TreeOpType,
  TreeEntityType,
  TreeOpParams,
} from "@/core/lib/offlineTypes";
import { makeLogger } from "@/core/lib/logger";

const log = makeLogger("tree-sync");

/**
 * Service for managing the persistent tree operation queue (pendingTreeOps).
 *
 * Responsibilities:
 * - CRUD operations for the Dexie pendingTreeOps table
 * - Coalescing redundant queued ops before drain
 *
 * Queue drain (replay to server) is handled in treeQueueDrain.ts.
 */

/** Get all pending ops across all projects, ordered by id (FIFO). */
export async function getAllPendingOps(): Promise<PendingTreeOp[]> {
  return db.pendingTreeOps
    .orderBy("id")
    .filter((op) => op.status === "pending")
    .toArray();
}

/** Queue a tree mutation op to Dexie for later replay. */
export async function queueTreeOp(
  projectId: string,
  opType: TreeOpType,
  entityType: TreeEntityType,
  entityId: string,
  params: TreeOpParams,
): Promise<void> {
  const op: PendingTreeOp = {
    projectId,
    opType,
    entityType,
    entityId,
    params,
    createdAt: new Date().toISOString(),
    status: "pending",
  } as PendingTreeOp;

  await db.pendingTreeOps.add(op);
  log.debug("Queued tree op", opType, entityType, entityId);
}

/** Get all pending ops for a project, ordered by id (FIFO). */
export async function getPendingOpsForProject(
  projectId: string,
): Promise<PendingTreeOp[]> {
  return db.pendingTreeOps
    .where("[projectId+status]")
    .equals([projectId, "pending"])
    .sortBy("id");
}

/** Get all pending ops for a specific entity. */
export async function getPendingOpsForEntity(
  entityId: string,
): Promise<PendingTreeOp[]> {
  // No entityId index exists on pendingTreeOps (only ++id, projectId, [projectId+status]).
  // Scan all rows via projectId > "" and filter in memory; queue size is expected to stay small.
  return db.pendingTreeOps
    .where("projectId")
    .above("")
    .filter((op) => op.entityId === entityId && op.status === "pending")
    .sortBy("id");
}

/** Remove a single completed/processed op by id. */
export async function removePendingOp(id: number): Promise<void> {
  await db.pendingTreeOps.delete(id);
}

/** Remove all pending ops for a specific entity (used for coalescing / discard). */
export async function removeOpsForEntity(entityId: string): Promise<void> {
  // Same indexed-query workaround as getPendingOpsForEntity: no entityId index in schema.
  const ops = await db.pendingTreeOps
    .where("projectId")
    .above("")
    .filter((op) => op.entityId === entityId && op.status === "pending")
    .toArray();

  if (ops.length > 0) {
    const ids = ops
      .map((op) => op.id)
      .filter((id): id is number => id !== undefined);
    await db.pendingTreeOps.bulkDelete(ids);
    log.debug("Removed", ids.length, "ops for entity", entityId);
  }
}

/**
 * Coalesce redundant ops for the same entity.
 *
 * Rules (per the phase plan):
 * - Rename A → "X", then rename A → "Y": keep only second rename
 * - Move A to B, then move A to C: keep only second move
 * - Rename A, then delete A: keep only delete
 * - Different entities: preserve all
 *
 * Returns a new array of coalesced ops (does NOT mutate Dexie — caller decides
 * whether to persist the coalesced result).
 */
export function coalesceOps(ops: PendingTreeOp[]): PendingTreeOp[] {
  if (ops.length <= 1) return [...ops];

  // Group by entityId to coalesce within each entity
  const byEntity = new Map<string, PendingTreeOp[]>();
  for (const op of ops) {
    const existing = byEntity.get(op.entityId);
    if (existing) {
      existing.push(op);
    } else {
      byEntity.set(op.entityId, [op]);
    }
  }

  const result: PendingTreeOp[] = [];

  for (const [, entityOps] of byEntity) {
    if (entityOps.length === 1) {
      result.push(entityOps[0]!);
      continue;
    }

    // Process ops in order — later ops supersede earlier ones of the same type
    const coalesced = coalesceEntityOps(entityOps);
    result.push(...coalesced);
  }

  // Sort by original id to preserve global FIFO ordering
  return result.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

/**
 * Coalesce ops for a single entity.
 *
 * Walks the ops in order. If a delete is encountered, everything before it
 * is discarded and only the delete remains. For rename/move, only the last
 * of each type survives.
 */
function coalesceEntityOps(ops: PendingTreeOp[]): PendingTreeOp[] {
  // If any op is a delete, only the delete matters (discard all prior ops)
  const lastDelete = ops.findLast((op) => op.opType === "delete");
  if (lastDelete) {
    return [lastDelete];
  }

  // Keep only the last rename and last move
  let lastRename: PendingTreeOp | undefined;
  let lastMove: PendingTreeOp | undefined;

  for (const op of ops) {
    if (op.opType === "rename") lastRename = op;
    if (op.opType === "move") lastMove = op;
  }

  const result: PendingTreeOp[] = [];
  if (lastRename) result.push(lastRename);
  if (lastMove) result.push(lastMove);

  // Sort by id to maintain FIFO order among surviving ops
  return result.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}
