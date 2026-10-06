/** Failure copy says what failed; the error is loud only while it ends the transcript. */
import type { Turn } from "@meridian/contracts/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@/client/query/useTurnLiveLineage", () => ({
  useTurnLiveLineage: () => ({ documents: [], receipt: null }),
}));
vi.mock("./AssistantTurnActions", () => ({
  AssistantTurnActions: () => <span data-turn-actions />,
}));

import { AssistantTurn } from "./AssistantTurn";

// No blocks in either case: block count must not decide send vs generation.
const failedTurn = {
  id: "failed",
  threadId: "thread-1",
  role: "assistant",
  status: "error",
  error: "provider unavailable",
  blocks: [],
} as unknown as Turn;
const interruptedTurn = { ...failedTurn, metadata: { reason: "interrupted" } } as unknown as Turn;

const SEND = "Couldn&#x27;t send.";

function render(endsTranscript: boolean, failedSendRetry?: () => void) {
  return renderToStaticMarkup(
    <AssistantTurn
      turn={failedTurn}
      isLatestAssistant
      endsTranscript={endsTranscript}
      failedSendRetry={failedSendRetry}
    />,
  );
}

describe("AssistantTurn failure", () => {
  it("shows send copy with Retry on a failed first send that ends the transcript", () => {
    const html = render(true, () => undefined);

    expect(html).toContain('role="alert"');
    expect(html).toContain(SEND);
    expect(html).toContain("Retry");
  });

  it("keeps a failed first send quiet with send copy and no Retry once a turn follows", () => {
    const html = render(false, () => undefined);

    expect(html).toContain(SEND);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("<button");
  });

  it("shows generation copy for an admitted reply that failed before any output", () => {
    const active = render(true);
    expect(active).toContain('role="alert"');
    expect(active).toContain("This response failed.");
    expect(active).not.toContain(SEND);
    expect(active).not.toContain("<button");

    const historical = render(false);
    expect(historical).toContain("This response failed.");
    expect(historical).not.toContain(SEND);
    expect(historical).not.toContain('role="alert"');
  });

  it("offers Retry on a failed reply only while it ends the transcript", () => {
    const retry = { onRetry: () => undefined, refused: false, requestLost: false };
    const current = renderToStaticMarkup(
      <AssistantTurn turn={failedTurn} endsTranscript replyRetry={retry} />,
    );
    expect(current).toContain("This response failed.");
    expect(current).toContain("data-reply-retry");

    const older = renderToStaticMarkup(
      <AssistantTurn
        turn={failedTurn}
        endsTranscript={false}
        replyRetry={{ ...retry, onRetry: undefined }}
      />,
    );
    expect(older).toContain("This response failed.");
    expect(older).not.toContain("<button");
  });

  it("shows a reply a shutdown cut off as an ordinary failed reply, with Retry", () => {
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={interruptedTurn}
        endsTranscript
        replyRetry={{
          onRetry: () => undefined,
          refused: false,
          requestLost: false,
        }}
      />,
    );
    expect(html).toContain("This response failed.");
    expect(html).not.toContain("interrupted");
    expect(html).toContain("data-reply-retry");
  });

  it("says the provider declined with no Retry, and keeps Retry when the gateway would retry", () => {
    const retry = { onRetry: () => undefined, refused: false, requestLost: false };
    const providerError = { status: 402, message: "Insufficient Balance" };
    const declinedTurn = {
      ...failedTurn,
      metadata: { reason: "provider_error", retryable: false, providerError },
    } as unknown as Turn;
    const declined = renderToStaticMarkup(
      <AssistantTurn turn={declinedTurn} endsTranscript replyRetry={retry} />,
    );
    expect(declined).toContain(
      "The AI provider turned this request down. Trying again won&#x27;t help until that&#x27;s fixed.",
    );
    expect(declined).not.toContain("data-reply-retry");
    expect(declined).not.toContain("Insufficient Balance");

    const exhausted = {
      ...failedTurn,
      metadata: { reason: "rate_limited", retryable: true, providerError },
    } as unknown as Turn;
    const html = renderToStaticMarkup(
      <AssistantTurn turn={exhausted} endsTranscript replyRetry={retry} />,
    );
    expect(html).toContain("This response failed.");
    expect(html).toContain("data-reply-retry");
  });

  it("shows a lost Retry's stand-in as a retry that never started, with no action row", () => {
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={failedTurn}
        endsTranscript
        standIn
        replyRetry={{ onRetry: () => undefined, refused: false, requestLost: true }}
      />,
    );
    expect(html).toContain("Couldn&#x27;t start the retry. Try again.");
    expect(html).not.toContain("This response failed.");
    expect(html).not.toContain("data-turn-actions");
    // A settled server reply keeps its action row.
    expect(render(true)).toContain("data-turn-actions");
  });
});
