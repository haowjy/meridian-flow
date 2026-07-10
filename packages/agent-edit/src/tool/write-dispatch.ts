// Dispatches validated write commands to their owning handlers.
import type { ActorSession } from "../ports/actor-session-store.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { WriteCommand, WriteContext } from "./types.js";
import type { createWriteCommands } from "./write-commands.js";
import type { createWriteReversalEndpoints } from "./write-reversal-endpoints.js";

export function createWriteDispatch(input: {
  commands: ReturnType<typeof createWriteCommands>;
  reversal: ReturnType<typeof createWriteReversalEndpoints>;
}) {
  return async function dispatch(
    command: WriteCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    switch (command.command) {
      case "read":
        return input.commands.read(command, session, context);
      case "create":
        return input.commands.create(command, session, context);
      case "insert":
      case "replace":
        return input.commands.mutate(command, session, context);
      case "undo":
      case "redo":
        return input.reversal.undoOrRedo(command, session, command.command, context);
    }
  };
}
