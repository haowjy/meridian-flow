import type * as Y from "yjs";
import type { z } from "zod";
import type { ActorSession } from "../ports/actor-session-store.js";
import { DocumentNotFoundError, isDocumentNotFoundError } from "../ports/document-coordinator.js";
import { ReadCommandSchema, WriteCommandSchema } from "./command-schema.js";
import { createDocumentEditCommands } from "./document-edits.js";
import { createDocumentRenderer } from "./document-renderer.js";
import { createDocumentSave } from "./document-save.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { AgentEditResultCommand } from "./model-result.js";
import { status, toOutcome } from "./response-format.js";
import { openRoom } from "./room.js";
import type {
  DocumentCommandName,
  ReadFunction,
  WriteContext,
  WriteFunction,
  WriteOutcome,
} from "./types.js";
import { createWriteCommands } from "./write-commands.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import { createWriteDispatch } from "./write-dispatch.js";
import {
  createAutoTurnIdNonce,
  fallbackCommandName,
  writeError,
  writeSchemaError,
} from "./write-helpers.js";

export type { CreateWriteToolOptions } from "./write-deps.js";
export interface WriteTool {
  read: ReadFunction;
  write: WriteFunction;
  /**
   * A host's read of the document a call would see: the room copy. The caller disposes it.
   */
  readRoom(
    docId: string,
    scope: { workDraftId?: string },
  ): Promise<{ doc: Y.Doc; room: string | null; dispose(): void }>;
}

export function createWriteTool(options: CreateWriteToolOptions): WriteTool {
  const localSessions = new Map<string, ActorSession>();
  const autoTurnIdNonce = createAutoTurnIdNonce();
  const autoTurnCounter = { value: 0 };
  const renderer = createDocumentRenderer({ model: options.model, codec: options.codec });
  const journal = options.journal;
  const documentSave = createDocumentSave({
    coordinator: options.coordinator,
    model: options.model,
    links: options.links,
  });
  const commands = createWriteCommands({
    options: {
      model: options.model,
      codec: options.codec,
      coordinator: options.coordinator,
      links: options.links,
      onLinkSpliceFallback: options.onLinkSpliceFallback,
      onObservationFailed: options.onObservationFailed,
    },
    autoTurnCounter,
    autoTurnIdNonce,
    renderer,
    journal,
    documentSave,
  });
  const documentEdits = createDocumentEditCommands({ options });
  const dispatch = createWriteDispatch({ commands, documentEdits });

  const read: ReadFunction = async (command, context = {}) => {
    const parsed = ReadCommandSchema.safeParse(command);
    if (!parsed.success) return invalidCommand("read", parsed.error);
    return execute("read", parsed.data, context, (valid, session) =>
      valid.format === "edits"
        ? documentEdits(valid, session, context)
        : commands.read(valid, session, context),
    );
  };

  const write: WriteFunction = async (command, context = {}) => {
    const parsed = WriteCommandSchema.safeParse(command);
    if (!parsed.success) return invalidCommand(fallbackCommandName(command), parsed.error);
    return execute(parsed.data.command, parsed.data, context, (valid, session) =>
      dispatch(valid, session, context),
    );
  };

  function invalidCommand(commandName: AgentEditResultCommand, error: z.ZodError): WriteOutcome {
    return toOutcome(commandName, status("invalid_write", writeSchemaError(error)));
  }

  async function execute<
    Command extends { file: string; documentId?: string; tool_use_id?: string },
  >(
    commandName: DocumentCommandName,
    validCommand: Command,
    context: WriteContext,
    run: (command: Command, session: ActorSession) => Promise<InternalWriteResult>,
  ): Promise<WriteOutcome> {
    const session = await resolveSession(context);
    const toolUseId = validCommand.tool_use_id ?? context.tool_use_id;
    let result: InternalWriteResult;
    try {
      result = await run(validCommand, session);
    } catch (cause) {
      // A file gone under the write is an answer, not a failure to diagnose.
      try {
        if (!isDocumentNotFoundError(cause))
          options.onUnexpectedWriteError?.({
            cause,
            command: commandName,
            ...(validCommand.documentId ? { documentId: validCommand.documentId } : {}),
            sessionId: session.id,
            threadId: session.threadId,
            ...(context.turnId ? { turnId: context.turnId } : {}),
            ...(context.responseIdentity?.modelResponseId
              ? { responseId: context.responseIdentity.modelResponseId }
              : {}),
            ...(toolUseId ? { toolUseId } : {}),
          });
      } catch {
        // Host diagnostics must never change the model-facing write outcome.
      }
      result = writeError(cause, commandName);
    }
    return toOutcome(commandName, result, validCommand.file);
  }

  async function resolveSession(context: WriteContext): Promise<ActorSession> {
    if (context.session) return context.session;
    if (context.externalId && options.actorSessionStore) {
      return options.actorSessionStore.resolve(context.externalId);
    }
    const actorThreadId =
      context.actor?.kind === "agent" || context.actor?.kind === "human"
        ? context.actor.threadId
        : undefined;
    const id = context.sessionId ?? options.defaultSessionId ?? "default-session";
    const threadId = actorThreadId ?? context.threadId ?? options.defaultThreadId ?? id;
    const existing = localSessions.get(id);
    if (existing) return existing;
    const session: ActorSession = { id, threadId };
    localSessions.set(id, session);
    return session;
  }

  return {
    read,
    write,
    async readRoom(docId, { workDraftId }) {
      const room = await openRoom(options.coordinator, {
        docId,
        commandName: "read",
        ...(workDraftId ? { workDraftId } : {}),
      });
      if (isInternalWriteResult(room)) throw new DocumentNotFoundError(docId);
      return room;
    },
  };
}
