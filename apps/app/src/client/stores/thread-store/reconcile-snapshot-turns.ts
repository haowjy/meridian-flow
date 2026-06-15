/**
 * reconcile-snapshot-turns — identity-based turn snapshot reconciliation.
 *
 * This is the replacement reconcile for the unified block-with-status model,
 * added ahead of wiring. It never compares timestamps: shared turn IDs take
 * server turn fields, and shared block sequences take server block fields,
 * while explicitly optimistic turns and live non-terminal tail blocks survive.
 */
import type { Block, Turn, TurnStatus } from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";

import { isOptimisticTurnId } from "./optimistic-turn-id";

export type ReconcileSnapshotTurnsOptions = {
  /**
   * Server lifecycle hint for the assistant turn that is still running even if
   * the snapshot's `turns[]` projection has not caught up to include it yet.
   */
  runningTurnId?: string | null;
};

function uniqueById(turns: readonly Turn[]): Turn[] {
  const seen = new Set<string>();
  const uniqueTurns: Turn[] = [];
  for (const turn of turns) {
    if (seen.has(turn.id)) continue;
    seen.add(turn.id);
    uniqueTurns.push(turn);
  }
  return uniqueTurns;
}

function reconcileBlocks(
  local: readonly Block[],
  server: readonly Block[],
  serverStatus: TurnStatus,
): Block[] {
  if (isTerminalTurnStatus(serverStatus)) return [...server];

  const serverSequences = new Set(server.map((block) => block.sequence));
  const maxServerSequence = server.reduce((max, block) => Math.max(max, block.sequence), -1);

  /**
   * `sequence` is the block identity inside one turn. Server blocks replace
   * the same sequence, but local blocks beyond a non-terminal snapshot's max
   * sequence are the live tail that may have arrived before the snapshot head.
   * Terminal server turns are fully authoritative and skip this path.
   */
  const localTail = local.filter(
    (block) => !serverSequences.has(block.sequence) && block.sequence > maxServerSequence,
  );

  const bySequence = new Map<number, Block>();
  for (const block of localTail) {
    bySequence.set(block.sequence, block);
  }
  for (const block of server) {
    bySequence.set(block.sequence, block);
  }

  return Array.from(bySequence.values()).sort((a, b) => a.sequence - b.sequence);
}

/**
 * Reconcile local store turns with an authoritative server snapshot.
 *
 * Server turn order is authoritative: the server has already imposed causal
 * `prevTurnId` ordering, including same-millisecond createdAt ties. Local-only
 * optimistic/running turns are threaded around that ordered server spine using
 * their nearest local neighbors so optimistic rows do not jump unnecessarily.
 * Within a shared turn, blocks are ordered by `sequence`.
 */
export function reconcileSnapshotTurns(
  local: Turn[],
  server: Turn[],
  options: ReconcileSnapshotTurnsOptions = {},
): Turn[] {
  const serverTurns = uniqueById(server);
  const localTurns = uniqueById(local);
  const localById = new Map(localTurns.map((turn) => [turn.id, turn]));
  const reconciled: Turn[] = serverTurns.map((serverTurn) => {
    const localTurn = localById.get(serverTurn.id);
    if (!localTurn) return serverTurn;
    return {
      ...serverTurn,
      blocks: reconcileBlocks(localTurn.blocks, serverTurn.blocks, serverTurn.status),
    };
  });

  const reconciledIds = new Set(reconciled.map((turn) => turn.id));
  const runningTurnId = options.runningTurnId ?? null;

  function insertLocalOnlyTurn(localTurn: Turn, localIndex: number): void {
    for (let index = localIndex - 1; index >= 0; index -= 1) {
      const previousLocalTurn = localTurns[index];
      if (!previousLocalTurn || !reconciledIds.has(previousLocalTurn.id)) continue;
      const previousResultIndex = reconciled.findIndex((turn) => turn.id === previousLocalTurn.id);
      reconciled.splice(previousResultIndex + 1, 0, localTurn);
      reconciledIds.add(localTurn.id);
      return;
    }

    for (let index = localIndex + 1; index < localTurns.length; index += 1) {
      const nextLocalTurn = localTurns[index];
      if (!nextLocalTurn || !reconciledIds.has(nextLocalTurn.id)) continue;
      const nextResultIndex = reconciled.findIndex((turn) => turn.id === nextLocalTurn.id);
      reconciled.splice(nextResultIndex, 0, localTurn);
      reconciledIds.add(localTurn.id);
      return;
    }

    reconciled.push(localTurn);
    reconciledIds.add(localTurn.id);
  }

  localTurns.forEach((localTurn, localIndex) => {
    if (reconciledIds.has(localTurn.id)) return;
    if (!isOptimisticTurnId(localTurn.id) && localTurn.id !== runningTurnId) return;
    insertLocalOnlyTurn(localTurn, localIndex);
  });

  return reconciled;
}
