// @vitest-environment jsdom
/** Destination Chat consumes durable Home continuity without repeat dispatch. */
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";
import { ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
import { FirstSendContinuity, FirstSendContinuityProvider } from "@/client/first-send-continuity";
import type { ThreadStoreActions } from "@/client/stores";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { useThreadHandoff } from "./useThreadHandoff";

let accountId: string;
let owner: FirstSendContinuity;
let handoff: ReturnType<typeof useThreadHandoff>;
const restoredRevision = () => 1;
beforeEach(() => {
  accountId = crypto.randomUUID();
  owner = new FirstSendContinuity(accountId);
});
afterEach(() => vi.restoreAllMocks());
const envelope = serializeComposerDraft(plainComposerDoc("Opening"), 3);
const key = { projectId: "project-1", threadId: "thread-1", submissionId: envelope.submissionId };
const actions = { consumePendingStream: () => null } as unknown as ThreadStoreActions;
function Harness({
  controller,
  restoreLatest = restoredRevision,
  restoreFailed = restoredRevision,
}: {
  controller: ThreadRunController;
  restoreLatest?: (snapshot: typeof envelope.draft, expectedRevision: number) => number | null;
  restoreFailed?: () => number | null;
}) {
  handoff = useThreadHandoff(
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
    agent: {
      slug: "writer",
      name: "writer",
      selection: { catalogEntryId: "writer-entry", definitionRevisionId: "writer-revision" },
    },
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
  it("exposes ambiguity and uses read-only status checks without another append", async () => {
    await stage();
    const scenario = new ThreadRunScenario({
      append: async () => {
        throw new TypeError("offline");
      },
    });
    const unmount = await mount(scenario.controller);
    try {
      await vi.waitFor(() => expect(handoff.recovery?.busy).toBe(false));
      expect(handoff.blocksSubmission).toBe(true);
      expect(handoff.recovery?.text).toBe("Opening");
      const lookups = scenario.lookupRequests.length;
      await act(async () => handoff.recovery?.checkStatus());
      expect(scenario.lookupRequests).toHaveLength(lookups + 1);
      expect(scenario.appendRequests).toHaveLength(1);
      expect(handoff.blocksSubmission).toBe(true);
      expect(await owner.peek(key)).not.toBeNull();
    } finally {
      await unmount();
    }
  });

  it.each([
    "storage failure",
    "external retirement",
  ] as const)("releases recovery controls after %s during status check", async (failure) => {
    await stage();
    const result = {
      kind: "ambiguous",
      submissionId: envelope.submissionId,
      acceptedRevision: envelope.acceptedRevision,
    } as const;
    const controller = {
      submit: vi.fn(async () => result),
      lookup: vi.fn(async () => {
        if (failure === "storage failure")
          vi.spyOn(FirstSendContinuity.prototype, "peek").mockRejectedValueOnce(
            new Error("temporary storage failure"),
          );
        else {
          const observed = await owner.peek(key);
          if (observed) await owner.retire(observed);
        }
        return result;
      }),
      resume: vi.fn(),
    } as unknown as ThreadRunController;
    const unmount = await mount(controller);
    try {
      await vi.waitFor(() => expect(handoff.recovery?.busy).toBe(false));
      await act(async () => handoff.recovery?.checkStatus());
      if (failure === "storage failure") {
        expect(handoff.recovery?.busy).toBe(false);
        expect(handoff.blocksSubmission).toBe(true);
        expect(await owner.peek(key)).not.toBeNull();
      } else {
        expect(handoff.recovery).toBeNull();
        expect(handoff.blocksSubmission).toBe(false);
      }
    } finally {
      await unmount();
    }
  });

  it("waits for server retirement before restoring and unlocking Send", async () => {
    await stage();
    const scenario = new ThreadRunScenario({
      append: async () => {
        throw new TypeError("offline");
      },
      retire: async ({ submissionId }) => ({ kind: "retired", submissionId, code: "retired" }),
    });
    const restore = vi.fn(() => {
      expect(scenario.retireRequests).toHaveLength(1);
      return 1;
    });
    const unmount = await mount(scenario.controller, undefined, restore);
    try {
      await vi.waitFor(() => expect(handoff.recovery?.busy).toBe(false));
      await act(async () => handoff.recovery?.startOver());
      expect(restore).toHaveBeenCalledTimes(1);
      expect(await owner.peek(key)).toBeNull();
      expect(handoff.blocksSubmission).toBe(false);
    } finally {
      await unmount();
    }
  });

  it("dispatches ready once, then reconciles durable identity on remount", async () => {
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
    const controller = {
      submit,
      recoverFirstSend: lookup,
      resume: vi.fn(),
    } as unknown as ThreadRunController;
    const unmount = await mount(controller);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await unmount();
    const unmountAgain = await mount(controller);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledTimes(1);
    await unmountAgain();
  });

  it("recovers the persisted envelope with one same-ID POST and retires continuity", async () => {
    await stage();
    await owner.findForThread(key.projectId, key.threadId);
    await owner.markAmbiguous(key);
    const scenario = new ThreadRunScenario();
    const unmount = await mount(scenario.controller);
    await vi.waitFor(async () => expect(await owner.peek(key)).toBeNull());
    expect(scenario.appendRequests).toHaveLength(1);
    expect(scenario.appendRequests[0]?.data).toMatchObject({
      threadId: key.threadId,
      submissionId: envelope.submissionId,
      text: envelope.text,
    });
    await unmount();
    const unmountAgain = await mount(scenario.controller);
    expect(scenario.appendRequests).toHaveLength(1);
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
      recoverFirstSend: vi.fn(),
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
      recoverFirstSend: vi.fn(),
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
      recoverFirstSend: vi.fn(),
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
      recoverFirstSend: vi.fn(),
      resume: vi.fn(),
    } as unknown as ThreadRunController;
    const unmount = await mount(controller, undefined, restoreFailed);
    await vi.waitFor(() => expect(restoreFailed).toHaveBeenCalledTimes(1));
    expect(await owner.findForThread("project-1", "thread-1")).toBeNull();
    await unmount();
  });
});
