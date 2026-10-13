/** Thread data commands: list, view, context (model requests), events (journal replay). */
import { apiThreadSnapshotPath, type ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import {
  type CommandSpec,
  flag,
  intOption,
  requirePositional,
  stringOption,
} from "../../core/command";
import { blockTimings, renderBlocks } from "./block-timing";
import { projectChatView, renderChatView, selectRows, viewSnapshot } from "./chat-view";
import { ReducedThread } from "./reduced-thread";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";

export const threadViewCommand: CommandSpec = {
  path: ["thread", "view"],
  summary: "Chat transcript as the app draws it: rows, replies' items, status, usage",
  args: "<thread>",
  route: "GET /api/threads/:threadId/snapshot",
  options: {
    ...THREAD_TARGET_OPTIONS,
    turn: { type: "string", description: "Only this row's turn (id or id prefix)" },
    last: { type: "string", description: "Show the last N rows (default 20)" },
    full: { type: "boolean", description: "No truncation, all rows" },
    blocks: {
      type: "boolean",
      description: "Per-block timing instead: sequence, type, tool, created time, gap, size",
    },
  },
  examples: [
    "./mf thread view c3   # ref in the default project",
    "./mf thread view p7 --project <projectId>",
    "./mf thread view 3f9a1c   # unique id prefix",
    "./mf thread view <id> --turn <turnId> --full",
    "./mf thread view <id> --json --fields rows",
    "./mf thread view <id> --blocks --json | jq -c '.blocks[] | select(.gapMs > 5000)'",
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
    // Turns come from the shared reducer's store, as the app builds them; the shared
    // view model then decides the rows, as the app does.
    const reduced = new ReducedThread(threadId);
    reduced.hydrate(snapshot);
    const view = viewSnapshot(snapshot, reduced.turns());
    const selection = {
      full: flag(ctx, "full"),
      turnId: stringOption(ctx, "turn"),
      last: intOption(ctx, "last", 20),
    };
    if (flag(ctx, "blocks")) {
      const { rows } = selectRows(view.rows, selection);
      ctx.out.result(
        blockTimings(
          threadId,
          rows.map((row) => row.turn),
        ),
        renderBlocks,
      );
    } else {
      ctx.out.result(projectChatView(snapshot, view, selection), renderChatView);
    }
    return undefined;
  },
};
