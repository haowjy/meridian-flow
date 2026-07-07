// Command dispatch and session resolution for the write tool.
import type { ActorSession } from "../ports/actor-session-store.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { WriteCommand, WriteContext } from "./types.js";
import { createWriteCommands } from "./write-commands.js";
import type { WriteToolInternals } from "./write-deps.js";
import { createWriteReversalEndpoints } from "./write-reversal-endpoints.js";

export function createWriteDispatch(deps: WriteToolInternals) {
  const commands = createWriteCommands(deps);
  const reversal = createWriteReversalEndpoints(deps);
  const { options, localSessions } = deps;

  return {
    dispatch,
    resolveSession,
    ...commands,
    ...reversal,
  };

  async function dispatch(
    command: WriteCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    switch (command.command) {
      case "read":
        return commands.read(command, session, context);
      case "create":
        return commands.create(command, session, context);
      case "insert":
      case "replace":
        return commands.mutate(command, session, context);
      case "undo":
      case "redo":
        return reversal.undoOrRedo(command, session, command.command, context);
    }
  }

  async function resolveSession(context: WriteContext): Promise<ActorSession> {
    if (context.session) return context.session;
    if (context.externalId && options.actorSessionStore) {
      return options.actorSessionStore.resolve(context.externalId);
    }

    const id = context.sessionId ?? options.defaultSessionId ?? "default-session";
    const threadId = context.threadId ?? options.defaultThreadId ?? id;
    return localSession(id, threadId);
  }

  function localSession(id: string, threadId: string): ActorSession {
    const existing = localSessions.get(id);
    if (existing) return existing;
    const session: ActorSession = { id, threadId, documents: new Map() };
    localSessions.set(id, session);
    return session;
  }
}
