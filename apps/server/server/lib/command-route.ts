/** The command record's HTTP doors. */
import type { CommandId, ProjectId, UserId } from "@meridian/contracts";
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
import {
  type CommandEnvelope,
  CommandExistsError,
  commandDigest,
  replay,
} from "../shared/commands/command-record.js";
import type { CommandStore } from "../shared/commands/drizzle-commands.js";
import { throwHttpInterrupt } from "../shared/interrupt-boundary.js";
import { requireRequestId } from "./request-id.js";

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
  if (found.kind !== "stored") return throwCommandConflict();
  return { commandId, outcome: found.outcome };
}

function throwCommandConflict(): never {
  return throwHttpInterrupt(
    meridianErrorFromSystem(
      COMMAND_CONFLICT_CODE,
      "That command id was used for a different command",
      false,
    ),
    409,
  );
}

/**
 * Splits a request body into its command id and the rest, which is what the command's digest
 * covers: a resend under the id must carry the same rest.
 */
export function splitCommandBody(raw: unknown): {
  commandId: CommandId;
  body: Record<string, unknown>;
} {
  const { commandId, ...body } = (raw ?? {}) as Record<string, unknown>;
  return { commandId: requireRequestId(commandId, "commandId") as CommandId, body };
}

/**
 * Runs a request that changes state as a command: the claim is the first write of the
 * transaction that makes the change, and a resend under the id answers the stored result
 * without running again. `refusal` names the causes inside the effect that are a final answer.
 * A cause that is not one, and a request turned away before this call, store nothing.
 */
export async function runRouteCommand<R extends { status: "done" | "refused" }>(
  store: CommandStore,
  input: {
    commandId: CommandId;
    userId: UserId;
    projectId: ProjectId;
    kind: CommandKind;
    /**
     * The command mints `projectId` (project create), so a resend carrying none would mint
     * another: the digest covers the body, which holds the id when the sender chose it.
     */
    mintsProject?: boolean;
    selectors?: Record<string, string | null>;
    body: unknown;
  },
  effect: () => Promise<R>,
  refusal: (cause: unknown) => R | undefined,
): Promise<R> {
  const envelope: CommandEnvelope = {
    commandId: input.commandId,
    accountId: input.userId,
    projectId: input.projectId,
    kind: input.kind,
    digest: commandDigest({
      accountId: input.userId,
      projectId: input.mintsProject ? "" : input.projectId,
      kind: input.kind,
      selectors: input.selectors ?? {},
      body: input.body,
    }),
  };
  try {
    return await store.run(envelope, effect, {
      outcomeOf: (result) => result.status,
      refusal,
    });
  } catch (cause) {
    if (!(cause instanceof CommandExistsError)) throw cause;
    const stored = replay<R>(
      await store.lookup({
        commandId: input.commandId,
        accountId: input.userId,
        digest: envelope.digest,
      }),
      input.commandId,
    );
    if (stored === null) throw cause;
    if (stored.status === "conflict") return throwCommandConflict();
    return stored;
  }
}
