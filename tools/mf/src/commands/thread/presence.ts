/**
 * `thread presence`: tell the server the writer is interacting with the chat's open question,
 * as the takeover does while it is used. The server moves the ask's deadline out (to 4 minutes
 * from now, never past 55 minutes after it opened) and keeps the answers sent as the draft a
 * timeout resolves from.
 */
import { apiThreadSnapshotPath, threadSnapshotSchema } from "@meridian/contracts/protocol";
import { EMPTY_CHAT_ASKS, openAsk, receiveAsks } from "@meridian/thread-client";
import { EXIT, usageError } from "../../core/cli-error";
import { type CommandSpec, requirePositional, stringOption } from "../../core/command";
import { jsonResponse } from "../../core/session";
import { ANSWER_OPTIONS, answerArgs } from "./answer";
import { resolveThreadId, THREAD_TARGET_OPTIONS } from "./resolve";
import { connectThreadClient } from "./transport";

/** The socket has no reply to a presence message; a closing socket still delivers what was sent. */
const FLUSH_MS = 300;

export const threadPresenceCommand: CommandSpec = {
  path: ["thread", "presence"],
  summary: "Report that the writer is answering the chat's open question (moves its deadline)",
  args: "<thread>",
  route: "WS /api/threads/ws ask.presence",
  options: {
    ...THREAD_TARGET_OPTIONS,
    ask: { type: "string", description: "Ask id (default: the chat's open ask)" },
    ...ANSWER_OPTIONS,
  },
  examples: [
    "./mf thread presence <id> --answer 'option:Left' --answer none",
    "./mf thread presence <id> --answers '[null,null]'",
  ],
  async run(ctx) {
    const answers = answerArgs(ctx);
    const session = await ctx.session();
    const threadId = await resolveThreadId(
      session,
      requirePositional(ctx, 0, "<thread>"),
      stringOption(ctx, "project"),
    );
    const snapshot = await session.request("GET", apiThreadSnapshotPath(threadId), undefined, {
      decode: jsonResponse(threadSnapshotSchema),
    });
    const asks = receiveAsks(EMPTY_CHAT_ASKS, snapshot.asks);
    const askId = stringOption(ctx, "ask") ?? openAsk(asks, snapshot.turns)?.ask.id;
    if (!askId) {
      ctx.out.result(
        { type: "thread.presence", outcome: "failed", reason: "no_open_ask" },
        () => "No open question in this chat",
      );
      return EXIT.notFound;
    }
    const transport = await connectThreadClient(session);
    try {
      if (!transport.sendAskPresence({ threadId, askId, answers }))
        throw usageError("The thread socket was not connected");
      await new Promise((resolve) => setTimeout(resolve, FLUSH_MS));
      ctx.out.result({ type: "thread.presence", outcome: "sent", askId }, () => `${askId} sent`);
      return EXIT.ok;
    } finally {
      transport.disconnect();
    }
  },
};
