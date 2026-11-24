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

export function throwCommandConflict(): never {
  return throwHttpInterrupt(
    meridianErrorFromSystem(
      COMMAND_CONFLICT_CODE,
      "That command id was used for a different command",
      false,
    ),
    409,
  );
}

export function splitCommandBody(raw: unknown): {
  commandId: CommandId;
  body: Record<string, unknown>;
} {
  const { commandId, ...body } = (raw ?? {}) as Record<string, unknown>;
  return { commandId: requireRequestId(commandId, "commandId") as CommandId, body };
}

export async function runRouteCommand<R extends { status: "done" | "refused" }>(
  store: CommandStore,
  input: {
    commandId: CommandId;
    userId: UserId;
    projectId: ProjectId;
    kind: CommandKind;
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
