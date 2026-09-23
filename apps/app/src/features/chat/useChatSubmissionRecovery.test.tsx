// @vitest-environment jsdom

/** Existing-thread reload recovery from the durable submission journal. */
import type { SendMessageResponse } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
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
  clearChatSubmissionRecoverySession,
  rememberSubmissionTurnId,
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
  // Session maps outlive a component mount; reset them so module memory cannot
  // leak across tests.
  clearChatSubmissionRecoverySession();
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

  it("keeps a proved rejection on the turn and retries with a reminted submission id", async () => {
    const scenario = new ThreadRunScenario();
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    // A live existing-thread send records the journal witness and appends the
    // row after mount; the POST then proves a rejection. The failed row must
    // stay attached to the turn instead of being dropped, and the fingerprint
    // is retained for Retry.
    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-rejected" }));
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, "Hello");
    await act(async () => {
      latest.current?.markRejected("sub-rejected", liveTurn.id);
    });

    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: liveTurn.id, status: "error" }),
    ]);
    expect(latest.current?.rejected).toEqual([
      expect.objectContaining({
        submissionId: "sub-rejected",
        optimisticTurnId: liveTurn.id,
        fingerprint: expect.objectContaining({ text: "Hello" }),
        draftRetained: true,
      }),
    ]);
    // A proved rejection retires the durable witness: recovery can never replay
    // a rejected admission under the same id.
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);

    await act(async () => {
      await latest.current?.retry(liveTurn.id);
    });

    expect(scenario.appendRequests).toHaveLength(1);
    expect(scenario.appendRequests[0]?.data.submissionId).not.toBe("sub-rejected");
    expect(scenario.appendRequests[0]).toMatchObject({ data: { text: "Hello" } });
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: "turn-user", status: "complete" }),
    ]);
    expect(latest.current?.rejected).toEqual([]);
  });

  it("resolves a retry that falls back to ambiguous through Check", async () => {
    let lookupResult: "pending" | "accepted" = "pending";
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) =>
        lookupResult === "accepted"
          ? {
              kind: "already-accepted",
              threadId: THREAD_ID,
              submissionId,
              userTurnId: "turn-server",
              assistantTurnId: "turn-assistant",
              resumeAfterSeq: "42",
              snapshotFloorNextSeq: "43",
            }
          : { kind: "pending", submissionId },
    });
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-ambiguous-retry" }));
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, "Hello");
    await act(async () => {
      latest.current?.markRejected("sub-ambiguous-retry", liveTurn.id);
    });
    // A 5xx retry is ambiguous: keep the fresh journal entry and expose Check.
    scenario.setAppend(async () => {
      throw new HttpResponseError("bad gateway", 502, null);
    });
    await act(async () => {
      await latest.current?.retry(liveTurn.id);
    });
    await act(async () => {
      await vi.waitFor(() => expect(latest.current?.recovered).toHaveLength(1));
    });
    const submissionId = latest.current?.recovered[0]?.submissionId ?? "";
    expect(submissionId).not.toBe("sub-ambiguous-retry");

    // Check must resolve that fresh identity back to its row.
    lookupResult = "accepted";
    await act(async () => {
      latest.current?.check(submissionId);
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(scenario.turns()).toEqual([
          expect.objectContaining({ id: "turn-server", status: "complete" }),
        ]);
      });
    });
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });

  it("remounts an ambiguous retry as Check, never a second Retry", async () => {
    let lookupResult: "pending" | "not-seen" = "pending";
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) =>
        lookupResult === "not-seen"
          ? { kind: "not-seen", submissionId }
          : { kind: "pending", submissionId },
    });
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    // A live rejection retains its fingerprint for Retry.
    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-ambiguous-remount" }));
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, "Hello");
    await act(async () => {
      latest.current?.markRejected("sub-ambiguous-remount", liveTurn.id);
    });
    expect(latest.current?.rejected).toHaveLength(1);

    // Retry returns 502: ambiguous. The fresh journal entry is the only
    // unresolved witness; the turn must offer Check, not Retry.
    scenario.setAppend(async () => {
      throw new HttpResponseError("bad gateway", 502, null);
    });
    await act(async () => {
      await latest.current?.retry(liveTurn.id);
    });
    await act(async () => {
      await vi.waitFor(() => expect(latest.current?.recovered).toHaveLength(1));
    });
    expect(latest.current?.rejected).toEqual([]);
    const journals = readChatSubmissions(ACCOUNT);
    expect(journals).toHaveLength(1);
    const freshId = journals[0]?.submissionId ?? "";
    expect(freshId).not.toBe("sub-ambiguous-remount");
    expect(scenario.appendRequests).toHaveLength(1);

    // Remount: the journal lookup resolves the unresolved retry to Check, and
    // the retired rejection must not resurrect Retry.
    await cleanup?.();
    cleanup = undefined;
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });
    await act(async () => {
      await vi.waitFor(() => expect(latest.current?.recovered).toHaveLength(1));
    });
    expect(latest.current?.rejected).toEqual([]);
    expect(readChatSubmissions(ACCOUNT)[0]?.submissionId).toBe(freshId);
    // No second dispatch on remount: only Check can replay, and it must reuse
    // the fresh identity rather than reminting yet another one.
    expect(scenario.appendRequests).toHaveLength(1);

    scenario.setAppend(async () => defaultSendResponse());
    lookupResult = "not-seen";
    await act(async () => {
      latest.current?.check(freshId);
    });
    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(2));
    });
    expect(scenario.appendRequests[1]?.data.submissionId).toBe(freshId);
    expect(scenario.turns()).toHaveLength(1);
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });

  it("surfaces Check and never replays beside an in-flight retry remount", async () => {
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-inflight" }));
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, "Hello");
    await act(async () => {
      latest.current?.markRejected("sub-inflight", liveTurn.id);
    });

    // Hold the retry POST so the unresolved send is in flight across a remount.
    const gate = scenarioGate<SendMessageResponse>();
    scenario.setAppend(() => gate.promise);
    let retrySettled = false;
    await act(async () => {
      void latest.current?.retry(liveTurn.id).then(() => {
        retrySettled = true;
      });
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });
    const freshId = readChatSubmissions(ACCOUNT)[0]?.submissionId ?? "";
    expect(freshId).not.toBe("sub-inflight");

    await cleanup?.();
    cleanup = undefined;
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });
    // The not-seen mount lookup is fenced by the shared in-flight lock: it must
    // expose Check instead of dispatching a second replay.
    await act(async () => {
      await vi.waitFor(() => expect(latest.current?.recovered).toHaveLength(1));
    });
    expect(latest.current?.rejected).toEqual([]);
    expect(scenario.appendRequests).toHaveLength(1);
    expect(readChatSubmissions(ACCOUNT)[0]?.submissionId).toBe(freshId);

    gate.resolve(defaultSendResponse());
    await act(async () => {
      await vi.waitFor(() => expect(retrySettled).toBe(true));
    });
  });

  it("keeps a recovered definitive rejection failed with a retry payload", async () => {
    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-recovered" }));
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({
        kind: "rejected",
        submissionId,
        code: "invalid_message",
      }),
    });
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    await act(async () => {
      await vi.waitFor(() => expect(scenario.turns()[0]?.status).toBe("error"));
    });
    await act(async () => {
      await vi.waitFor(() => expect(latest.current?.rejected).toHaveLength(1));
    });
    expect(latest.current?.rejected[0]).toMatchObject({
      submissionId: "sub-recovered",
      fingerprint: expect.objectContaining({ text: "Hello" }),
    });
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });

  it("reattaches a retained rejection across a thread remount", async () => {
    const scenario = new ThreadRunScenario();
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    // A live rejection retired the durable witness, but the failed row and its
    // retry payload are retained for the session.
    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-remount" }));
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, "Hello");
    await act(async () => {
      latest.current?.markRejected("sub-remount", liveTurn.id);
    });
    expect(latest.current?.rejected).toHaveLength(1);

    await cleanup?.();
    cleanup = undefined;

    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });
    await act(async () => {
      await vi.waitFor(() => expect(latest.current?.rejected).toHaveLength(1));
    });
    expect(latest.current?.rejected[0]).toMatchObject({
      optimisticTurnId: liveTurn.id,
      fingerprint: expect.objectContaining({ text: "Hello" }),
    });
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

  it("reuses the live row when recovery mounts while the POST is still held", async () => {
    const submission = entry({ submissionId: "sub-held" });
    recordChatSubmission(ACCOUNT, submission);
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "pending", submissionId }),
    });
    const gate = scenarioGate<SendMessageResponse>();
    scenario.setAppend(() => gate.promise);

    // Simulate ChatView.handleSubmit: append the live row and register it for
    // the session before the POST awaits admission.
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, submission.text);
    rememberSubmissionTurnId(ACCOUNT, submission.submissionId, liveTurn.id);
    const pendingPost = scenario.controller.submit(
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

    // Leave and return while the POST is still held. The server admission is
    // still `pending`, so recovery must reuse the registered row rather than
    // append a second pending copy.
    scenario.controller.teardown();
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });
    await act(async () => {
      await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));
    });
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: liveTurn.id, status: "pending" }),
    ]);

    // The held POST then lands: the stale session bridges the same row, so a
    // single row remains without any Check click.
    gate.resolve(defaultSendResponse());
    await act(async () => {
      await expect(pendingPost).resolves.toMatchObject({ kind: "ambiguous" });
    });
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: "turn-user", status: "complete" }),
    ]);
    // No recovery control is offered: the remembered id was bridged away.
    expect(
      latest.current?.recovered.some((entry) =>
        scenario.turns().some((turn) => turn.id === entry.optimisticTurnId),
      ),
    ).toBe(false);
    expect(readChatSubmissions(ACCOUNT)).toHaveLength(1);
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
