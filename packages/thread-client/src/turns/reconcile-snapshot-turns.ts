import type { Block, Turn, TurnStatus } from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";

import { isOptimisticTurnId } from "../view/optimistic-turn-id";
import { sameBlock, sameTurn } from "./same-turn";

export type ReconcileSnapshotTurnsOptions = {
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
  let reconciled: Block[];
  if (isTerminalTurnStatus(serverStatus)) {
    reconciled = [...server];
  } else {
    const serverSequences = new Set(server.map((block) => block.sequence));
    const maxServerSequence = server.reduce((max, block) => Math.max(max, block.sequence), -1);

    const localTail = local.filter(
      (block) => !serverSequences.has(block.sequence) && block.sequence > maxServerSequence,
    );

    const bySequence = new Map<number, Block>();
    for (const block of localTail) bySequence.set(block.sequence, block);
    for (const block of server) bySequence.set(block.sequence, block);
    reconciled = Array.from(bySequence.values()).sort((a, b) => a.sequence - b.sequence);
  }

  const localBySequence = new Map(local.map((block) => [block.sequence, block]));
  const shared = reconciled.map((block) => {
    const localBlock = localBySequence.get(block.sequence);
    return localBlock && sameBlock(localBlock, block) ? localBlock : block;
  });
  return shared.length === local.length && shared.every((block, index) => block === local[index])
    ? (local as Block[])
    : shared;
}

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
    const nextTurn = {
      ...serverTurn,
      // keep: Forgetting is write-once; an older snapshot must not clear a stamp the store already holds
      forgottenBy: localTurn.forgottenBy ?? serverTurn.forgottenBy,
      blocks: reconcileBlocks(localTurn.blocks, serverTurn.blocks, serverTurn.status),
    };
    return sameTurn(localTurn, nextTurn) ? localTurn : nextTurn;
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
    if (!isOptimisticTurnId(localTurn.id) && localTurn.id !== runningTurnId) {
      return;
    }
    insertLocalOnlyTurn(localTurn, localIndex);
  });

  return reconciled.length === local.length &&
    reconciled.every((turn, index) => turn === local[index])
    ? local
    : reconciled;
}
