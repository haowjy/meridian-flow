// @vitest-environment jsdom
/** Destination Chat consumes durable Home continuity without repeat dispatch. */
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { FirstSendContinuity, FirstSendContinuityProvider } from "@/client/first-send-continuity";
import type { ThreadStoreActions } from "@/client/stores";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { useThreadHandoff } from "./useThreadHandoff";

const accountId = "continuity-test-account";
const owner = new FirstSendContinuity(accountId);
const envelope = serializeComposerDraft(plainComposerDoc("Opening"), 3);
const key = { projectId: "project-1", threadId: "thread-1", submissionId: envelope.submissionId };
const actions = { consumePendingStream: () => null } as unknown as ThreadStoreActions;
function Harness({
  controller,
  restoreLatest = () => true,
  restoreFailed = () => true,
}: {
  controller: ThreadRunController;
  restoreLatest?: () => boolean;
  restoreFailed?: () => boolean;
}) {
  useThreadHandoff(
    "thread-1",
    "project-1",
    controller,
    actions,
    undefined,
    restoreLatest,
    restoreFailed,
  );
  return null;
}
async function mount(
  controller: ThreadRunController,
  restoreLatest?: () => boolean,
  restoreFailed?: () => boolean,
) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <FirstSendContinuityProvider accountId={accountId}>
          <Harness
            controller={controller}
            restoreLatest={restoreLatest}
            restoreFailed={restoreFailed}
          />
        </FirstSendContinuityProvider>
      </QueryClientProvider>,
    ),
  );
  return () => act(async () => root.unmount());
}
async function stage(latestDraft: typeof envelope.draft | null = null) {
  await owner.stage({
    ...key,
    envelope,
    latestDraft,
    optimisticUserTurnId: "optimistic-1",
    state: "ready",
  });
}
afterEach(async () => owner.remove(key));

describe("useThreadHandoff durable continuity", () => {
  it("dispatches ready once, then remount lookup-only while ambiguous", async () => {
    await stage();
    const submit = vi.fn(
      async () =>
        ({
          kind: "ambiguous",
          submissionId: envelope.submissionId,
          acceptedRevision: envelope.acceptedRevision,
        }) as const,
    );
    const lookup = vi.fn(
      async () =>
        ({
          kind: "ambiguous",
          submissionId: envelope.submissionId,
          acceptedRevision: envelope.acceptedRevision,
        }) as const,
    );
    const controller = { submit, lookup, resume: vi.fn() } as unknown as ThreadRunController;
    const unmount = await mount(controller);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await unmount();
    const unmountAgain = await mount(controller);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledTimes(1);
    await unmountAgain();
  });

  it("removes accepted only after later snapshot restoration acknowledgement", async () => {
    const later = { ...envelope.draft, revision: 8 };
    await stage(later);
    const restoreLatest = vi.fn(() => true);
    const controller = {
      submit: vi.fn(async () => ({
        kind: "accepted",
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      })),
      lookup: vi.fn(),
      resume: vi.fn(),
    } as unknown as ThreadRunController;
    const unmount = await mount(controller, restoreLatest);
    await vi.waitFor(async () =>
      expect(await owner.findForThread("project-1", "thread-1")).toBeNull(),
    );
    expect(restoreLatest).toHaveBeenCalledWith(later);
    await unmount();
  });

  it("restores a definite rejection once and removes the exact record", async () => {
    await stage();
    const restoreFailed = vi.fn(() => true);
    const controller = {
      submit: vi.fn(async () => ({
        kind: "rejected",
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      })),
      lookup: vi.fn(),
      resume: vi.fn(),
    } as unknown as ThreadRunController;
    const unmount = await mount(controller, undefined, restoreFailed);
    await vi.waitFor(() => expect(restoreFailed).toHaveBeenCalledTimes(1));
    expect(await owner.findForThread("project-1", "thread-1")).toBeNull();
    await unmount();
  });
});
