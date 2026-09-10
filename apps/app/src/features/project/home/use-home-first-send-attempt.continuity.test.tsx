// @vitest-environment jsdom
/** Home creation stages exact durable continuity before destination navigation. */
import "fake-indexeddb/auto";
import type { Thread } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  msg: (parts: TemplateStringsArray) => parts.join(""),
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

import { FirstSendContinuity, FirstSendContinuityProvider } from "@/client/first-send-continuity";
import type { ThreadStoreActions } from "@/client/stores";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { useHomeFirstSendAttempt } from "./use-home-first-send-attempt";

const accountId = "home-continuity-account";
const continuity = new FirstSendContinuity(accountId);
const submission = serializeComposerDraft(plainComposerDoc("Exact opening"), 4, {
  anchor: 6,
  head: 2,
});
const actions = {
  ensureThread: vi.fn(),
  appendUserTurn: vi.fn(() => ({ id: "optimistic-1" })),
  removeOptimisticUserTurn: vi.fn(),
} as unknown as ThreadStoreActions;
let current: ReturnType<typeof useHomeFirstSendAttempt>;
function Harness(props: Parameters<typeof useHomeFirstSendAttempt>[0]) {
  current = useHomeFirstSendAttempt(props);
  return null;
}
async function mount(props: Parameters<typeof useHomeFirstSendAttempt>[0]) {
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <FirstSendContinuityProvider accountId={accountId}>
          <Harness {...props} />
        </FirstSendContinuityProvider>
      </QueryClientProvider>,
    ),
  );
  return () => act(async () => root.unmount());
}
function thread(workId: string | null): Thread {
  return {
    id: "thread-stable",
    projectId: "project-1",
    workId: workId as never,
    userId: "user-1",
    kind: "primary",
    status: "active",
    title: "Exact opening",
    slug: "exact-opening",
    currentAgent: null,
    activeLeafTurnId: null,
    turnCount: 0,
    isFavorite: false,
    actionRequired: false,
    runningTurnId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Thread;
}
afterEach(async () => {
  await continuity.remove({
    projectId: "project-1",
    threadId: "thread-stable",
    submissionId: submission.submissionId,
  });
  vi.clearAllMocks();
});

describe("useHomeFirstSendAttempt continuity", () => {
  it("retains the exact selected Work and a newer full snapshot racing creation", async () => {
    let release!: (value: Thread) => void;
    const createThread = vi.fn(
      (_projectId: string, _request: unknown) =>
        new Promise<Thread>((resolve) => {
          release = resolve;
        }),
    );
    const onSelectThread = vi.fn(async () => {});
    const unmount = await mount({
      projectId: "project-1",
      actions,
      onSelectThread,
      createThread: createThread as never,
      makeId: () => "thread-stable",
    });
    let pending!: Promise<boolean>;
    act(() => {
      pending = current.submit(submission, { workId: "work-1", agentSlug: "general" });
    });
    const later = { ...submission.draft, revision: 9, selection: { anchor: 2, head: 1 } };
    act(() => current.updateDraft({ text: submission.text, snapshot: later }));
    await act(async () => release(thread("work-1")));
    await expect(pending).resolves.toBe(true);
    expect(createThread.mock.calls[0]?.[1]).toMatchObject({ workId: "work-1" });
    const claim = await continuity.claim({
      projectId: "project-1",
      threadId: "thread-stable",
      submissionId: submission.submissionId,
    });
    expect(claim?.record.latestDraft).toEqual(later);
    await unmount();
  });
});
