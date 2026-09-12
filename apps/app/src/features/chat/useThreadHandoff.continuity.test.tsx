// @vitest-environment jsdom
/** Destination Chat consumes durable Home continuity without repeat dispatch. */
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { FirstSendContinuity, FirstSendContinuityProvider } from "@/client/first-send-continuity";
import type { ThreadStoreActions } from "@/client/stores";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { useThreadHandoff } from "./useThreadHandoff";

let accountId: string;
let owner: FirstSendContinuity;
beforeEach(() => {
  accountId = crypto.randomUUID();
  owner = new FirstSendContinuity(accountId);
});
const envelope = serializeComposerDraft(plainComposerDoc("Opening"), 3);
const key = { projectId: "project-1", threadId: "thread-1", submissionId: envelope.submissionId };
const actions = { consumePendingStream: () => null } as unknown as ThreadStoreActions;
function Harness({
  controller,
  restoreLatest = () => 1,
  restoreFailed = () => 1,
}: {
  controller: ThreadRunController;
  restoreLatest?: (snapshot: typeof envelope.draft, expectedRevision: number) => number | null;
  restoreFailed?: () => number | null;
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
  restoreLatest?: (snapshot: typeof envelope.draft, expectedRevision: number) => number | null,
  restoreFailed?: () => number | null,
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
  await stageCreation();
  if (latestDraft)
    await owner.saveCreationDraft(
      key.projectId,
      (await owner.readCreation(key.projectId)).revision,
      latestDraft,
    );
}
async function stageCreation() {
  const saved = await owner.saveCreationDraft(key.projectId, 0, envelope.draft);
  await owner.beginCreation(key.projectId, saved.slot.revision, {
    attemptId: "attempt",
    projectId: key.projectId,
    threadId: key.threadId,
    title: "Opening",
    workId: null,
    agentSlug: "writer",
    submission: envelope,
    phase: "creating",
  });
  await owner.publishCreation(key.projectId, "attempt", {
    projectSlug: "serial",
    threadSlug: "opening",
    optimisticUserTurnId: "optimistic",
  });
}

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
    const restoreLatest = vi.fn(() => 1);
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
    expect(restoreLatest).toHaveBeenCalledWith(later, 0);
    await unmount();
  });

  it("restores typing persisted while first-send acceptance was pending", async () => {
    await stageCreation();
    let accept!: () => void;
    const pending = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const submit = vi.fn(async () => {
      await pending;
      return {
        kind: "accepted",
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      };
    });
    const restoreLatest = vi.fn(() => 1);
    const controller = {
      submit,
      lookup: vi.fn(),
      resume: vi.fn(),
    } as unknown as ThreadRunController;
    const unmount = await mount(controller, restoreLatest);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const later = { ...envelope.draft, revision: 12 };
    await owner.saveCreationDraft(
      key.projectId,
      (await owner.readCreation(key.projectId)).revision,
      later,
    );
    accept();
    try {
      await vi.waitFor(() => expect(restoreLatest).toHaveBeenCalledWith(later, 0));
      await vi.waitFor(async () => expect(await owner.peek(key)).toBeNull());
      expect(await owner.readCreation(key.projectId)).toMatchObject({ attempt: null, draft: null });
    } finally {
      await unmount();
    }
  });

  it("keeps recovery durable when destination typing wins while acceptance is pending", async () => {
    await stageCreation();
    let accept!: () => void;
    const pending = new Promise<void>((resolve) => {
      accept = resolve;
    });
    let destinationRevision = 0;
    const restoreLatest = vi.fn((_snapshot, expectedRevision) =>
      expectedRevision === destinationRevision ? ++destinationRevision : null,
    );
    const submit = vi.fn(async () => {
      await pending;
      return {
        kind: "accepted",
        submissionId: envelope.submissionId,
        acceptedRevision: envelope.acceptedRevision,
      };
    });
    const controller = {
      submit,
      lookup: vi.fn(),
      resume: vi.fn(),
    } as unknown as ThreadRunController;
    const unmount = await mount(controller, restoreLatest);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    destinationRevision += 1;
    const later = { ...envelope.draft, revision: 12 };
    await owner.saveCreationDraft(
      key.projectId,
      (await owner.readCreation(key.projectId)).revision,
      later,
    );
    accept();
    try {
      await vi.waitFor(() => expect(restoreLatest).toHaveBeenCalledWith(later, 0));
      expect(destinationRevision).toBe(1);
      expect(await owner.peek(key)).not.toBeNull();
      expect((await owner.readCreation(key.projectId)).attempt?.attemptId).toBe("attempt");
    } finally {
      await unmount();
    }
  });

  it("restores a definite rejection once and removes the exact record", async () => {
    await stage();
    const restoreFailed = vi.fn(() => 1);
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
