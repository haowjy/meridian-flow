// @vitest-environment jsdom

/** Existing-thread reload recovery from the durable submission journal. */
import type { SendMessageResponse } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExistingThreadChatSubmission } from "@/client/chat-submissions";
import {
  bindChatSubmissions,
  readChatSubmissions,
  recordChatSubmission,
} from "@/client/chat-submissions";
import {
  defaultSendResponse,
  scenarioGate,
  ThreadRunScenario,
} from "@/client/copilot/test-support/ThreadRunScenario";
import {
  type ChatSubmissionRecovery,
  useChatSubmissionRecovery,
} from "./useChatSubmissionRecovery";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
  msg: (strings: TemplateStringsArray) => ({ id: strings[0] }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "account";
const THREAD_ID = "thread_1";

function entry(
  overrides: Partial<ExistingThreadChatSubmission> = {},
): ExistingThreadChatSubmission {
  return {
    kind: "existing-thread",
    submissionId: "sub-1",
    threadId: THREAD_ID,
    projectId: "project-1",
    createdAt: "2026-09-22T12:00:00.000Z",
    text: "Hello",
    blocks: [{ type: "text", text: "Hello" }],
    references: [],
    activatedSkillSlugs: [],
    ...overrides,
  };
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  window.localStorage.clear();
});

beforeEach(() => {
  window.localStorage.clear();
  bindChatSubmissions(ACCOUNT);
});

async function mount(
  accountId: string,
  scenario: ThreadRunScenario,
  onRecovery: (value: ReturnType<typeof useChatSubmissionRecovery>) => void,
) {
  const actions = scenario.store.getState();
  function Probe() {
    const recovery = useChatSubmissionRecovery(THREAD_ID, accountId, scenario.controller, actions);
    onRecovery(recovery);
    return <span data-testid="recovered-count">{recovery.recovered.length}</span>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe />);
  });
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host };
}

describe("useChatSubmissionRecovery", () => {
  it("restores a pending row and retires the entry when lookup is accepted", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({
        kind: "already-accepted",
        threadId: THREAD_ID,
        submissionId,
        userTurnId: "turn-server",
        assistantTurnId: "turn-assistant",
        resumeAfterSeq: "42",
        snapshotFloorNextSeq: "43",
      }),
    });

    await mount(ACCOUNT, scenario, () => undefined);

    await act(async () => {
      await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));
    });
    expect(scenario.lookupRequests[0]).toEqual({
      threadId: THREAD_ID,
      submissionId: "sub-1",
    });
    await act(async () => {
      await vi.waitFor(() => {
        const turns = scenario.turns();
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ id: "turn-server", status: "complete" });
      });
    });
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });

  it("keeps the row and entry pending when lookup is ambiguous", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "pending", submissionId }),
    });
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };

    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    await act(async () => {
      await vi.waitFor(() => expect(latest.current?.recovered).toHaveLength(1));
    });
    expect(scenario.turns()[0]).toMatchObject({ status: "pending" });
    expect(readChatSubmissions(ACCOUNT)).toHaveLength(1);
    expect(latest.current?.recovered[0]?.submissionId).toBe("sub-1");
  });

  it("replays the stored fingerprint with the same submission id when lookup is not-seen", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });

    await mount(ACCOUNT, scenario, () => undefined);

    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });
    expect(scenario.appendRequests[0]).toMatchObject({
      data: { threadId: THREAD_ID, submissionId: "sub-1", text: "Hello" },
    });
    expect(scenario.lookupRequests).toHaveLength(1);

    // The default append is accepted, so the replay bridges the row and retires
    // the entry: exactly one user row, no Start over / Check recovery surface.
    await act(async () => {
      await vi.waitFor(() => expect(readChatSubmissions(ACCOUNT)).toEqual([]));
    });
    expect(scenario.turns()).toHaveLength(1);
    expect(scenario.turns()[0]).toMatchObject({ id: "turn-user", status: "complete" });
  });

  it("marks the row failed and retires the entry on a definitive rejection", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({
        kind: "rejected",
        submissionId,
        code: "invalid_message",
      }),
    });

    await mount(ACCOUNT, scenario, () => undefined);

    await act(async () => {
      await vi.waitFor(() => expect(scenario.turns()[0]?.status).toBe("error"));
    });
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });

  it("does not recover another account's entries", async () => {
    recordChatSubmission(ACCOUNT, entry());
    bindChatSubmissions("account-b");
    const scenario = new ThreadRunScenario();
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };

    await mount("account-b", scenario, (value) => {
      latest.current = value;
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(latest.current?.recovered).toEqual([]);
    expect(scenario.lookupRequests).toEqual([]);
    expect(scenario.turns()).toEqual([]);
    expect(readChatSubmissions("account-b")).toEqual([]);
    // A's entry survives for A's next bind.
    bindChatSubmissions(ACCOUNT);
    expect(readChatSubmissions(ACCOUNT)).toHaveLength(1);
  });

  it("reuses the restored row when a thread remounts while still ambiguous", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "pending", submissionId }),
    });

    await mount(ACCOUNT, scenario, () => undefined);
    await act(async () => {
      await vi.waitFor(() => expect(scenario.turns()).toHaveLength(1));
    });
    await cleanup?.();
    cleanup = undefined;

    await mount(ACCOUNT, scenario, () => undefined);
    await act(async () => {
      await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(2));
    });

    expect(scenario.turns()).toHaveLength(1);
    expect(readChatSubmissions(ACCOUNT)).toHaveLength(1);
  });

  it("does not append a second row when remounted after acknowledgement", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({
        kind: "already-accepted",
        threadId: THREAD_ID,
        submissionId,
        userTurnId: "turn-server",
        assistantTurnId: "turn-assistant",
        resumeAfterSeq: "42",
        snapshotFloorNextSeq: "43",
      }),
    });

    await mount(ACCOUNT, scenario, () => undefined);
    await act(async () => {
      await vi.waitFor(() => expect(scenario.turns()).toHaveLength(1));
    });
    await cleanup?.();
    cleanup = undefined;

    await mount(ACCOUNT, scenario, () => undefined);
    await act(async () => {
      await Promise.resolve();
    });

    expect(scenario.lookupRequests).toHaveLength(1);
    expect(scenario.turns()).toHaveLength(1);
  });

  it("collapses the recovery append onto the row bridged after an epoch mismatch", async () => {
    const submission = entry({ submissionId: "sub-mismatch" });
    recordChatSubmission(ACCOUNT, submission);
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({
        kind: "already-accepted",
        threadId: THREAD_ID,
        submissionId,
        userTurnId: "turn-user",
        assistantTurnId: "turn-assistant",
        resumeAfterSeq: "42",
        snapshotFloorNextSeq: "43",
      }),
    });
    const gate = scenarioGate<SendMessageResponse>();
    scenario.setAppend(() => gate.promise);

    // Simulate ChatView.handleSubmit: the live row is appended before the POST.
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, "Hello");
    const pending = scenario.controller.submit(
      THREAD_ID,
      {
        submissionId: submission.submissionId,
        acceptedRevision: 0,
        text: submission.text,
        blocks: submission.blocks,
        references: submission.references,
        activatedSkillSlugs: submission.activatedSkillSlugs,
      },
      { optimisticUserTurnId: liveTurn.id },
    );
    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });

    // Leave the thread while the POST is held, then let it land.
    scenario.controller.teardown();
    gate.resolve(defaultSendResponse());
    await act(async () => {
      await expect(pending).resolves.toMatchObject({ kind: "ambiguous" });
    });
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: "turn-user", status: "complete" }),
    ]);
    expect(readChatSubmissions(ACCOUNT)).toHaveLength(1);

    // Return to the thread: recovery must collapse its temporary append onto
    // the bridged row, not leave a permanent pending duplicate.
    await mount(ACCOUNT, scenario, () => undefined);
    await act(async () => {
      await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));
    });
    await act(async () => {
      await vi.waitFor(() => expect(readChatSubmissions(ACCOUNT)).toEqual([]));
    });
    expect(scenario.turns()).toHaveLength(1);
    expect(scenario.turns()[0]).toMatchObject({ id: "turn-user", status: "complete" });
  });

  it("replays the stored fingerprint through the shared path on an in-session Check", async () => {
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    // Simulate ChatView.handleSubmit after mount: the journal witness and live
    // row exist, but the mount effect already ran, so recovery has not tracked
    // them. This is the composer Check path, not a remount.
    const submission = entry({ submissionId: "sub-check" });
    recordChatSubmission(ACCOUNT, submission);
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, "Hello");

    const lookup = await scenario.controller.lookupSubmission(THREAD_ID, submission.submissionId, {
      optimisticUserTurnId: liveTurn.id,
      keepOptimisticOnFailure: true,
    });
    expect(lookup.kind).toBe("not-seen");

    await act(async () => {
      await latest.current?.replaySubmission(submission.submissionId, liveTurn.id);
    });

    expect(scenario.appendRequests).toHaveLength(1);
    expect(scenario.appendRequests[0]).toMatchObject({
      data: { threadId: THREAD_ID, submissionId: "sub-check", text: "Hello" },
    });
    expect(scenario.turns()).toHaveLength(1);
    expect(scenario.turns()[0]).toMatchObject({ id: "turn-user", status: "complete" });
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });
});
