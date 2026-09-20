/**
 * Renders a claimed inbox batch into a model request: a `steer` becomes a
 * user-role message at the tail, a `system` message becomes a request-only
 * notice (it never persists a turn). Pure, so batch rendering is testable
 * apart from the loop; producers are not special-cased — the body decides.
 */
import type { Notice } from "../../notices/index.js";
import { user } from "../gateway/helpers/messages.js";
import type { Message } from "../gateway/index.js";
import type { InboxMessage } from "./ports.js";

export function renderInboxBatch(
  messages: readonly Message[],
  batch: readonly InboxMessage[],
): { messages: Message[]; notices: Notice[] } {
  const rendered = [...messages];
  const notices: Notice[] = [];
  for (const message of batch) {
    if (message.intent === "steer") {
      rendered.push(user(inboxMessageText(message)));
    } else {
      notices.push(inboxMessageNotice(message));
    }
  }
  return { messages: rendered, notices };
}

function inboxMessageText(message: InboxMessage): string {
  switch (message.body.kind) {
    case "text":
    case "report":
      return message.body.text;
    case "context":
      return message.body.parts.map((part) => part.text).join("\n\n");
  }
}

function inboxMessageNotice(message: InboxMessage): Notice {
  return {
    id: message.seq,
    kind: "inbox_system",
    scope: { kind: "thread", threadId: message.threadId },
    message: inboxMessageText(message),
    data: {},
    createdAt: new Date(message.enqueuedAt),
  };
}
