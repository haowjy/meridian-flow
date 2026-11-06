/**
 * `thread presence`: tell the server the writer is interacting with the chat's open question,
 * as the takeover does while it is used. The server moves the ask's deadline out (to 4 minutes
 * from now, never past 55 minutes after it opened). With `--answer`/`--answers` it also keeps
 * them as the draft a timeout resolves from; without, the draft it holds stays.
 */
import { EXIT, usageError } from "../../core/cli-error";
import { type CommandSpec, listOption, stringOption } from "../../core/command";
import { ANSWER_OPTIONS, answerArgs, resolveOpenAsk } from "./answer";
import { THREAD_TARGET_OPTIONS } from "./resolve";
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
    "./mf thread presence <id>",
    "./mf thread presence <id> --answer 'option:Left' --answer none",
    "./mf thread presence <id> --answers '[null,null]'",
  ],
  async run(ctx) {
    const answers =
      listOption(ctx, "answer").length > 0 || stringOption(ctx, "answers") !== undefined
        ? answerArgs(ctx)
        : undefined;
    const target = await resolveOpenAsk(ctx, "thread.presence");
    if (!target) return EXIT.notFound;
    const { session, threadId, askId } = target;
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
