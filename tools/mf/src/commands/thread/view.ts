/** Thread data commands: list, view, context (model requests), events (journal replay). */
import { apiThreadSnapshotPath, threadSnapshotSchema } from "@meridian/contracts/protocol";
import {
  type CommandSpec,
  flag,
  intOption,
  requirePositional,
  stringOption,
} from "../../core/command";
import { blockTimings, renderBlocks } from "./block-timing";
import { chatSnapshot, projectChatView, renderChatView, selectRows } from "./chat-view";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";

export const threadViewCommand: CommandSpec = {
  path: ["thread", "view"],
  summary:
    "Chat transcript as the app draws it: rows, replies' items, status, usage, and the failure cards the durable facts give (the latest failed reply, usage; ./mf holds no local command state, so a lost Retry or an unsent message never appears)",
  args: "<thread>",
  route: "GET /api/threads/:threadId/snapshot",
  options: {
    ...THREAD_TARGET_OPTIONS,
    turn: { type: "string", description: "Only this row's turn (id or id prefix)" },
    last: { type: "string", description: "Show the last N rows (default 20)" },
    full: {
      type: "boolean",
      description:
        "No truncation, all rows. With --json it is the inspectable form: tool input/result/output/metadata and Work receipts, raw card content (a card prints only its kind; the app words a card's title and outcome itself), report payloads, handoff brief, delivery bodies, writer occurrences. Text mode summarizes and omits them",
    },
    blocks: {
      type: "boolean",
      description:
        "Per-block timing instead: sequence, type, tool, created time, gap, size. Times only the selected rows' turns (hidden plumbing and delivery turns are not timed)",
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
    const snapshot = await session.request("GET", apiThreadSnapshotPath(threadId), undefined, {
      parse: threadSnapshotSchema.safeParse,
    });
    // One authoritative read, no socket and no sync: the shared view model decides the rows, as the app does.
    const shown = chatSnapshot(snapshot, snapshot.turns);
    const { view } = shown;
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
      ctx.out.result(projectChatView(snapshot, shown, selection), renderChatView);
    }
    return undefined;
  },
};
