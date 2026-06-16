import type { AGUIEvent } from "@meridian/contracts/protocol";
import { EventType } from "@meridian/contracts/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  sendThreadMessage,
  subscribeThreadEvents,
  type ThreadEventSubscription,
} from "@/client/phase5-api";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  state?: "streaming" | "finished";
};

type ChatPaneProps = {
  threadId: string;
};

export function ChatPane({ threadId }: ChatPaneProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [status, setStatus] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const subscriptionRef = useRef<ThreadEventSubscription | null>(null);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setStatus("connecting");
    setError(null);

    const subscription = subscribeThreadEvents(threadId, {
      onStatus: (nextStatus) => {
        if (active) setStatus(nextStatus);
      },
      onError: (nextError) => {
        if (active) setError(nextError);
      },
      onEvent: (event) => {
        if (active) setMessages((current) => applyAssistantEvent(current, event));
      },
    });
    subscriptionRef.current = subscription;

    return () => {
      active = false;
      subscription.close();
      subscriptionRef.current = null;
    };
  }, [threadId]);

  const canSend = useMemo(() => composer.trim().length > 0 && !sending, [composer, sending]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = composer.trim();
    if (!text) return;

    setComposer("");
    setSending(true);
    setError(null);
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", text }]);

    try {
      const subscription = subscriptionRef.current;
      if (!subscription) {
        throw new Error("Thread subscription is not ready");
      }
      const connectionToken = await subscription.awaitConnectionToken();
      await sendThreadMessage(threadId, text, { connectionToken });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="pane chat-pane" data-testid="chat-pane" aria-label="Thread chat">
      <header className="pane-header">
        <div>
          <p className="eyebrow">Agent thread</p>
          <h2>Writer chat</h2>
        </div>
        <span className="debug-pill" data-testid="thread-ws-status">
          WS {status}
        </span>
      </header>

      <div className="turn-list" data-testid="chat-turn-list">
        {messages.length === 0 ? (
          <p className="empty-state">Send a note to start the fake streaming assistant turn.</p>
        ) : (
          messages.map((message) => (
            <article
              className={`turn ${message.role}`}
              data-turn-id={message.id}
              data-testid={`${message.role}-turn`}
              key={message.id}
            >
              <p className="turn-role">{message.role === "user" ? "You" : "Assistant"}</p>
              <p>{message.text}</p>
              {message.state ? (
                <small data-testid="assistant-turn-state" data-turn-id={message.id}>
                  {message.state}
                </small>
              ) : null}
            </article>
          ))
        )}
      </div>

      {error ? (
        <p className="error" data-testid="chat-error">
          {error}
        </p>
      ) : null}

      <form className="composer" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="phase5-composer">
          Message
        </label>
        <textarea
          data-testid="chat-composer"
          id="phase5-composer"
          onChange={(event) => setComposer(event.currentTarget.value)}
          placeholder="Ask the Writer to continue the chapter..."
          rows={3}
          value={composer}
        />
        <button data-testid="send-message" disabled={!canSend} type="submit">
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}

function applyAssistantEvent(messages: ChatMessage[], event: AGUIEvent): ChatMessage[] {
  if (event.type === EventType.RUN_STARTED) {
    return [...messages, { id: event.runId, role: "assistant", text: "", state: "streaming" }];
  }

  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    return appendAssistantText(messages, event.delta ?? "");
  }

  if (event.type === EventType.RUN_FINISHED) {
    return messages.map((message) =>
      message.role === "assistant" && message.id === event.runId
        ? { ...message, state: "finished" }
        : message,
    );
  }

  return messages;
}

function appendAssistantText(messages: ChatMessage[], delta: string): ChatMessage[] {
  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  if (lastAssistantIndex === -1) return messages;

  return messages.map((message, index) =>
    index === lastAssistantIndex ? { ...message, text: `${message.text}${delta}` } : message,
  );
}
