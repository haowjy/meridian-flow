/** The command record's HTTP doors. */
import type { CommandId, UserId } from "@meridian/contracts";
import { CommandIdSchema, type CommandLookupResponse } from "@meridian/contracts/commands";
import type { CommandStore } from "../shared/commands/drizzle-commands.js";

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
