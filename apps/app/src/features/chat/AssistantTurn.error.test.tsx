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
vi.mock("./AssistantTurnActions", () => ({ AssistantTurnActions: () => null }));

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
    expect(active).toContain("Something went wrong generating a response.");
    expect(active).not.toContain(SEND);
    expect(active).not.toContain("<button");

    const historical = render(false);
    expect(historical).toContain("This response failed.");
    expect(historical).not.toContain(SEND);
    expect(historical).not.toContain('role="alert"');
  });
});
