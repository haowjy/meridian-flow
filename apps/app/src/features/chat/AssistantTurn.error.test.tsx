/** A failed reply is loud only while it ends the transcript; afterwards it is a quiet marker. */
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

const failedTurn = {
  id: "failed",
  threadId: "thread-1",
  role: "assistant",
  status: "error",
  error: "provider unavailable",
  blocks: [],
} as unknown as Turn;

function render(endsTranscript: boolean) {
  return renderToStaticMarkup(
    <AssistantTurn
      turn={failedTurn}
      isLatestAssistant
      endsTranscript={endsTranscript}
      onRetry={() => undefined}
    />,
  );
}

describe("AssistantTurn failure", () => {
  it("shows the active error with Retry while it ends the transcript", () => {
    const html = render(true);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Retry");
    expect(html).not.toContain("Errored.");
  });

  it("shows a quiet historical marker without Retry once a later turn follows", () => {
    const html = render(false);

    expect(html).toContain("Errored.");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("<button");
  });
});
