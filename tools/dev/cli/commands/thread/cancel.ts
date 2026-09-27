import {
  apiThreadCancelPath,
  apiThreadSnapshotPath,
  type CancelTurnResponse,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import { CliError, EXIT } from "../../core/cli-error";
import { type CommandSpec, requirePositional, stringOption } from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";

export const threadCancelCommand: CommandSpec = {
  path: ["thread", "cancel"],
  summary: "Cancel the running turn (or a given turn)",
  args: "<thread>",
  route: "POST /api/threads/:threadId/turns/:turnId/cancel",
  options: {
    ...THREAD_TARGET_OPTIONS,
    turn: { type: "string", description: "Turn id (default: the running turn)" },
  },
  examples: ["./mf thread cancel <id>"],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    let turnId = stringOption(ctx, "turn");
    if (!turnId) {
      const snapshot = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
      );
      turnId = snapshot.liveState.runningTurnId ?? undefined;
      if (!turnId) throw new CliError("not_found", "Thread has no running turn");
    }
    const response = await session.request<CancelTurnResponse>(
      "POST",
      apiThreadCancelPath(threadId, turnId),
    );
    ctx.out.result(response, (value) => `${value.turnId} ${value.status}`);
    return response.status === "not_found" ? EXIT.notFound : undefined;
  },
};
