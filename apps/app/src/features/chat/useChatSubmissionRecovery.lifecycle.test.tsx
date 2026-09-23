// @vitest-environment jsdom

/**
 * Recovery lifecycle ordering — mounts the real `useChatThreadSession` +
 * `useChatSubmissionRecovery` sibling pair (as `ChatView` does, session first)
 * under React `StrictMode`, matching the dev runtime that TanStack Start's
 * default client entry wraps the app in.
 *
 * These are regression tests for the epoch race where the session hook's
 * StrictMode teardown bumps the controller admission epoch in the same commit
 * that starts recovery, discarding the recovery lookup (no `not-seen` replay)
 * and leaving the journal unresolved (duplicate pending row on the next
 * return). They drive the hooks through mount/cleanup, not hook methods.
 */
import type { SendMessageResponse } from "@meridian/contracts/protocol";
import { act, StrictMode } from "react";
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
  clearChatSubmissionRecoverySession,
  rememberSubmissionTurnId,
  useChatSubmissionRecovery,
} from "./useChatSubmissionRecovery";
import { useChatThreadSession } from "./useChatThreadSession";

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

function payload(submission: ExistingThreadChatSubmission) {
  return {
    submissionId: submission.submissionId,
    acceptedRevision: 0,
    text: submission.text,
    blocks: submission.blocks,
    references: submission.references,
    activatedSkillSlugs: submission.activatedSkillSlugs,
  };
}

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
  window.localStorage.clear();
  clearChatSubmissionRecoverySession();
});

beforeEach(() => {
  window.localStorage.clear();
  bindChatSubmissions(ACCOUNT);
});

/** Mount the session + recovery hooks in `ChatView` order under StrictMode. */
async function mountChatLifecycle(accountId: string, scenario: ThreadRunScenario) {
  const actions = scenario.store.getState();
  function Probe() {
    useChatThreadSession({
      threadId: THREAD_ID,
      controller: scenario.controller,
      actions,
      isStreaming: false,
    });
    useChatSubmissionRecovery(THREAD_ID, accountId, scenario.controller, actions);
    return <span />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
  });
  // Flush the deferred recovery lookup/replay microtasks within `act`.
  await act(async () => {
    await Promise.resolve();
  });
  const unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  cleanups.push(unmount);
  return { unmount };
}

describe("useChatSubmissionRecovery lifecycle (StrictMode)", () => {
  it("auto-replays a not-seen existing-thread send after a full unmount/remount", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });

    const first = await mountChatLifecycle(ACCOUNT, scenario);

    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });
    expect(scenario.appendRequests[0]).toMatchObject({
      data: { threadId: THREAD_ID, submissionId: "sub-1", text: "Hello" },
    });
    await act(async () => {
      await vi.waitFor(() => expect(readChatSubmissions(ACCOUNT)).toEqual([]));
    });
    expect(scenario.turns()).toEqual([expect.objectContaining({ status: "complete" })]);

    // Full unmount/remount with a fresh controller (the reload shape): the
    // journal was retired by the replay, so the return neither appends nor
    // duplicates.
    await first.unmount();
    const reloaded = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });
    await mountChatLifecycle(ACCOUNT, reloaded);
    await act(async () => {
      await Promise.resolve();
    });
    expect(reloaded.lookupRequests).toHaveLength(0);
    expect(reloaded.appendRequests).toHaveLength(0);
  });

  it("leave/return held, then release, then a second return proves already-accepted with one row and no journal", async () => {
    const submission = entry({ submissionId: "sub-held" });
    let lookupKind: "not-seen" | "already-accepted" = "not-seen";
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) =>
        lookupKind === "not-seen"
          ? { kind: "not-seen", submissionId }
          : {
              kind: "already-accepted",
              threadId: THREAD_ID,
              submissionId,
              userTurnId: "turn-user",
              assistantTurnId: "turn-assistant",
              resumeAfterSeq: "42",
              snapshotFloorNextSeq: "43",
            },
    });
    const gate = scenarioGate<SendMessageResponse>();
    scenario.setAppend(() => gate.promise);

    // The user is on the thread; the send records the witness, appends the row,
    // and starts a POST that stays held.
    await mountChatLifecycle(ACCOUNT, scenario);
    recordChatSubmission(ACCOUNT, submission);
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, submission.text);
    rememberSubmissionTurnId(ACCOUNT, submission.submissionId, liveTurn.id);
    void scenario.controller.submit(THREAD_ID, payload(submission), {
      optimisticUserTurnId: liveTurn.id,
      keepOptimisticOnFailure: true,
    });
    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });

    // Leave and return while held: recovery proves not-seen and replays the same
    // identity (a second held POST). The row is reused, not duplicated.
    await cleanups.shift()?.();
    const held = await mountChatLifecycle(ACCOUNT, scenario);
    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(2));
    });
    expect(scenario.appendRequests[1]).toMatchObject({
      data: { threadId: THREAD_ID, submissionId: "sub-held" },
    });
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: liveTurn.id, status: "pending" }),
    ]);

    // Leave again before the held POSTs land, so acknowledgement happens away
    // from the thread and the witness is not retired by the in-flight replay.
    await held.unmount();
    gate.resolve(defaultSendResponse());
    await act(async () => {
      await vi.waitFor(() =>
        expect(scenario.turns()).toEqual([
          expect.objectContaining({ id: "turn-user", status: "complete" }),
        ]),
      );
    });
    // The witness survived the acknowledged release: that is exactly the state
    // the runtime reported (ambiguous accept from a stale session).
    expect(readChatSubmissions(ACCOUNT)).toHaveLength(1);
    const postsBeforeReturn = scenario.appendRequests.length;

    // The acknowledged row is bridged in the app-scoped store. Return once more:
    // the server proves already-accepted for the same identity, so recovery must
    // collapse the temporary append and retire the witness. `already-accepted`
    // never re-issues a POST, so the append count must not move.
    lookupKind = "already-accepted";
    await mountChatLifecycle(ACCOUNT, scenario);
    await act(async () => {
      await vi.waitFor(() => expect(readChatSubmissions(ACCOUNT)).toEqual([]));
    });
    expect(scenario.appendRequests).toHaveLength(postsBeforeReturn);
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: "turn-user", status: "complete" }),
    ]);
  });

  it("holds a recovery-only replay through a real unmount without acknowledging, subscribing, or retiring", async () => {
    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-unmount" }));
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });
    // The only POST in flight is recovery's own replay: no live send to blame
    // for a late acknowledgement if the writer leaves before it lands.
    const gate = scenarioGate<SendMessageResponse>();
    scenario.setAppend(() => gate.promise);

    const mounted = await mountChatLifecycle(ACCOUNT, scenario);
    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });
    const optimisticTurnId = scenario.turns()[0]?.id ?? "";
    expect(optimisticTurnId).not.toBe("");

    // A genuine unmount ends the recovery token before the held POST lands.
    await mounted.unmount();
    gate.resolve(defaultSendResponse());
    await act(async () => {
      await Promise.resolve();
    });

    // A stale replay must not acknowledge: the row stays pending under its
    // optimistic id instead of being renamed to the server turn.
    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: optimisticTurnId, status: "pending" }),
    ]);
    // It must not start a run either, so no live subscription was attached.
    expect(scenario.activeSubscription()).toBeUndefined();
    // The journal stays: the returning session's lookup owns the bridge/retire.
    expect(readChatSubmissions(ACCOUNT)).toMatchObject([{ submissionId: "sub-unmount" }]);
  });
});
