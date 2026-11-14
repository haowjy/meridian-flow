/** The command record's HTTP doors. */
import type { CommandId, UserId } from "@meridian/contracts";
import {
  COMMAND_CONFLICT_CODE,
  COMMAND_KINDS,
  CommandIdSchema,
  type CommandKind,
  type CommandLookupResponse,
  type CommandResolveResponse,
} from "@meridian/contracts/commands";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import type { CommandStore } from "../shared/commands/drizzle-commands.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";

/**
 * GET /api/commands/:id: what a command settled as, never a guess from the list. Another
 * account's id answers `none`, revealing nothing.
 */
export async function handleCommandLookup(
  store: CommandStore,
  input: { userId: UserId; commandId: string },
): Promise<CommandLookupResponse> {
  const id = CommandIdSchema.safeParse(input.commandId);
  if (!id.success) return { status: "none" };
  const found = await store.lookup({ commandId: id.data as CommandId, accountId: input.userId });
  return found.kind === "stored"
    ? { status: "stored", kind: found.commandKind, outcome: found.outcome }
    : { status: "none" };
}

/**
 * POST /api/commands/:id/resolve: the id's outcome, for a sender that does not know whether its
 * request landed. A request still running under the id is waited for; where there is none, a
 * `never` is stored so none can take effect later. It checks the account only: whoever holds an
 * id may settle it, and a stored row reveals nothing the sender did not send.
 */
export async function handleCommandResolve(
  store: CommandStore,
  input: { userId: UserId; commandId: string; body: unknown },
): Promise<CommandResolveResponse> {
  const id = CommandIdSchema.safeParse(input.commandId);
  const kind = (input.body as { kind?: unknown } | null)?.kind;
  if (!id.success || !COMMAND_KINDS.includes(kind as CommandKind))
    throw createError({ statusCode: 400, message: "Invalid command resolve request" });
  const commandId = id.data as CommandId;
  const found = await store.resolve({
    commandId,
    accountId: input.userId,
    kind: kind as CommandKind,
  });
  if (found.kind !== "stored")
    return throwHttpInterrupt(
      meridianErrorFromSystem(
        COMMAND_CONFLICT_CODE,
        "That command id was used for a different command",
        false,
      ),
      409,
    );
  return { commandId, outcome: found.outcome };
}
