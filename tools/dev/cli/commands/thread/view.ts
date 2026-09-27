/** Thread data commands: list, view, context (model requests), events (journal replay). */
import { apiThreadSnapshotPath, type ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import {
  type CommandSpec,
  flag,
  intOption,
  requirePositional,
  stringOption,
} from "../../core/command";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { projectThreadView, renderThreadView } from "./transcript";

export const threadViewCommand: CommandSpec = {
  path: ["thread", "view"],
  summary: "Transcript: turns, text, tool calls, status, usage",
  args: "<thread>",
  route: "GET /api/threads/:threadId/snapshot",
  options: {
    ...THREAD_TARGET_OPTIONS,
    turn: { type: "string", description: "Only this turn (id or id prefix)" },
    last: { type: "string", description: "Show the last N turns (default 20)" },
    full: { type: "boolean", description: "No truncation, all turns" },
  },
  examples: [
    "./mf thread view c3   # ref in the default project",
    "./mf thread view p7 --project <projectId>",
    "./mf thread view 3f9a1c   # unique id prefix",
    "./mf thread view <id> --turn <turnId> --full",
    "./mf thread view <id> --json --fields turns",
  ],
  async run(ctx) {
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const snapshot = await session.request<ThreadSnapshotResponse>(
      "GET",
      apiThreadSnapshotPath(threadId),
    );
    const view = projectThreadView(snapshot, {
      full: flag(ctx, "full"),
      turnId: stringOption(ctx, "turn"),
      last: intOption(ctx, "last", 20),
    });
    ctx.out.result(view, renderThreadView);
    return undefined;
  },
};
