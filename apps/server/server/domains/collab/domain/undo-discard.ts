/** Undo of a Discard as a command: the stored answer of a repeated id, else the store's effect. */
import type { BranchId, UserId } from "@meridian/contracts";
import type {
  UndoDiscardAnswer,
  UndoDiscardClick,
  UndoDiscardResult,
} from "@meridian/contracts/branches";
import {
  type CommandEnvelope,
  CommandExistsError,
  replay,
} from "../../../shared/commands/command-record.js";
import type { DocumentCommands } from "./document-commands.js";

export type UndoDiscardCommand = {
  /** The branch the Discard ran on; it may have closed with it. */
  branchId: BranchId;
  userId: UserId;
  request: UndoDiscardClick;
  envelope: CommandEnvelope;
};

export interface UndoDiscardStore {
  run(command: UndoDiscardCommand): Promise<UndoDiscardResult>;
}

export function createUndoDiscardService(input: {
  commands: DocumentCommands;
  store: UndoDiscardStore;
}) {
  return async function undoDiscard(command: UndoDiscardCommand): Promise<UndoDiscardAnswer> {
    const lookup = async () =>
      replay<UndoDiscardResult>(
        await input.commands.lookup(command.envelope),
        command.envelope.commandId,
      );
    const stored = await lookup();
    if (stored) return stored;
    try {
      return await input.store.run(command);
    } catch (cause) {
      if (cause instanceof CommandExistsError) {
        const winner = await lookup();
        if (winner) return winner;
      }
      throw cause;
    }
  };
}
