// @vitest-environment jsdom

/** Existing-thread reload recovery from the durable submission journal. */
import type { AdmissionLookup, SendMessageResponse, Turn } from "@meridian/contracts/protocol";
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
import { ComposerSessionDraft } from "@/client/composer-drafts";
import {
  defaultSendResponse,
  scenarioGate,
  ThreadRunScenario,
} from "@/client/copilot/test-support/ThreadRunScenario";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import {
  type DerivationIntent,
  resetDerivationsForTest,
  resumeDerivation,
} from "./derivation/derive-conversation";
import { projectUserTurn } from "./UserTurn";
import {
  type ChatSubmissionRecovery,
  clearChatSubmissionRecoverySession,
  rememberSubmissionTurnId,
  useChatSubmissionRecovery,
} from "./useChatSubmissionRecovery";
import { useComposerSessionDraft } from "./useComposerSessionDraft";

const threadsApi = vi.hoisted(() => ({ forkThread: vi.fn(), handoffThread: vi.fn() }));
vi.mock("@/client/api/threads-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...threadsApi,
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
  window.sessionStorage.clear();
  // Session maps outlive a component mount; reset them so module memory cannot
  // leak across tests.
  clearChatSubmissionRecoverySession();
  resetDerivationsForTest();
  threadsApi.forkThread.mockReset();
});

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
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
  it("does not replay an in-flight lookup after another tab proves rejection", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const gate = scenarioGate<AdmissionLookup>();
    const scenario = new ThreadRunScenario({ lookup: () => gate.promise });
    let recovery!: ChatSubmissionRecovery;
    await mount(ACCOUNT, scenario, (value) => {
      recovery = value;
    });
    await act(async () => {
      await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));
      recordChatSubmission(ACCOUNT, entry({ state: "rejected" }));
      window.dispatchEvent(new StorageEvent("storage"));
    });
    expect(recovery.rejected).toHaveLength(1);
    await act(async () => {
      gate.resolve({ kind: "not-seen", submissionId: "sub-1" });
      await gate.promise;
    });
    expect(scenario.appendRequests).toHaveLength(0);
    expect(readChatSubmissions(ACCOUNT)).toEqual([expect.objectContaining({ state: "rejected" })]);
  });

  it("keeps the journal and row pending when an in-flight lookup settles after unmount", async () => {
    recordChatSubmission(ACCOUNT, entry());
    const gate = scenarioGate<AdmissionLookup>();
    const scenario = new ThreadRunScenario({ lookup: () => gate.promise });

    await mount(ACCOUNT, scenario, () => undefined);
    await act(async () => {
      await vi.waitFor(() => expect(scenario.lookupRequests).toHaveLength(1));
    });
    const optimisticTurnId = scenario.turns()[0]?.id ?? "";

    // Unmount before the lookup lands: the token is gone, so the late
    // `already-accepted` result must not acknowledge the row or retire the
    // journal. The next mount reconciles it.
    await cleanup?.();
    cleanup = undefined;
    gate.resolve({
      kind: "already-accepted",
      threadId: THREAD_ID,
      submissionId: "sub-1",
      userTurnId: "turn-server",
      assistantTurnId: "turn-assistant",
      resumeAfterSeq: "42",
      snapshotFloorNextSeq: "43",
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(scenario.turns()).toEqual([
      expect.objectContaining({ id: optimisticTurnId, status: "pending" }),
    ]);
    expect(readChatSubmissions(ACCOUNT)).toMatchObject([{ submissionId: "sub-1" }]);
  });

  it("replays the stored fingerprint with the same submission id when lookup is not-seen", async () => {
    const reference = {
      type: "reference",
      text: "[refdoc2.md](manuscript://refdoc2.md)",
      documentId: "01900000-0000-7000-8000-000000000001",
      uri: "manuscript://refdoc2.md",
    } as const;
    recordChatSubmission(
      ACCOUNT,
      entry({
        text: `Hello${reference.text}`,
        blocks: [{ type: "text", text: "Hello" }, reference],
        references: [
          { documentId: reference.documentId, uri: reference.uri, purpose: "reference" },
        ],
      }),
    );
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });

    await mount(ACCOUNT, scenario, () => undefined);

    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });
    expect(scenario.appendRequests[0]).toMatchObject({
      data: { threadId: THREAD_ID, submissionId: "sub-1", text: `Hello${reference.text}` },
    });
    expect(scenario.lookupRequests).toHaveLength(1);
    // The recovered row draws the picked document by identity, not by path.
    const recoveredReferences = () => projectUserTurn(scenario.turns()[0] as Turn).references;
    expect(recoveredReferences()).toEqual([
      {
        from: 5,
        to: 5 + reference.text.length,
        documentId: reference.documentId,
        uri: reference.uri,
      },
    ]);

    // The default append is accepted, so the replay bridges the row and retires
    // the entry: exactly one user row, no Start over / Check recovery surface.
    await act(async () => {
      await vi.waitFor(() => expect(readChatSubmissions(ACCOUNT)).toEqual([]));
    });
    expect(scenario.turns()).toHaveLength(1);
    expect(scenario.turns()[0]).toMatchObject({ id: "turn-user", status: "complete" });
    expect(recoveredReferences()).toHaveLength(1);
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
    const liveTurn = scenario.store
      .getState()
      .appendUserTurn(THREAD_ID, [{ type: "text", text: "Hello" }]);
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
      }),
    ]);
    // Rejected payloads stay durable and are never automatically replayed.
    expect(readChatSubmissions(ACCOUNT)).toEqual([
      expect.objectContaining({ state: "rejected", submissionId: "sub-rejected" }),
    ]);

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
    const liveTurn = scenario.store
      .getState()
      .appendUserTurn(THREAD_ID, [{ type: "text", text: "Hello" }]);
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
    const liveTurn = scenario.store
      .getState()
      .appendUserTurn(THREAD_ID, [{ type: "text", text: "Hello" }]);
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

  it("reattaches a retained rejection across a thread remount", async () => {
    const scenario = new ThreadRunScenario();
    const latest: { current: ChatSubmissionRecovery | null } = { current: null };
    await mount(ACCOUNT, scenario, (value) => {
      latest.current = value;
    });

    // A live rejection retired the durable witness, but the failed row and its
    // retry payload are retained for the session.
    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-remount" }));
    const liveTurn = scenario.store
      .getState()
      .appendUserTurn(THREAD_ID, [{ type: "text", text: "Hello" }]);
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
    const liveTurn = scenario.store
      .getState()
      .appendUserTurn(THREAD_ID, [{ type: "text", text: "Hello" }]);
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
    const liveTurn = scenario.store.getState().appendUserTurn(THREAD_ID, submission.blocks);
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

  it("holds a recovery-only replay through a real unmount without acknowledging, subscribing, or retiring", async () => {
    recordChatSubmission(ACCOUNT, entry({ submissionId: "sub-unmount" }));
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
    });
    // The only POST in flight is recovery's own replay: no live send to blame
    // for a late acknowledgement if the writer leaves before it lands.
    const gate = scenarioGate<SendMessageResponse>();
    scenario.setAppend(() => gate.promise);

    await mount(ACCOUNT, scenario, () => undefined);
    await act(async () => {
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });
    const optimisticTurnId = scenario.turns()[0]?.id ?? "";
    expect(optimisticTurnId).not.toBe("");

    // A genuine unmount ends the recovery token before the held POST lands.
    await cleanup?.();
    cleanup = undefined;
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

  describe("a fork reloaded while it is still being created", () => {
    const intent: DerivationIntent = {
      kind: "fork",
      threadId: THREAD_ID,
      projectId: "project-1",
      sourceThreadId: "source",
      sourceTitle: "Chapter 12 plan",
      originTurnId: "cut",
      workId: null,
      agent: null,
      agentName: "General",
      createdAt: "2026-09-22T12:00:00.000Z",
    };

    function resumeCreation(scenario: ThreadRunScenario) {
      let settle!: { resolve: (thread: unknown) => void; reject: (error: unknown) => void };
      threadsApi.forkThread.mockReturnValue(
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        }),
      );
      // What ChatScreen does on reload, before the chat mounts.
      const threadActions = scenario.store.getState();
      resumeDerivation(intent, {
        accountId: ACCOUNT,
        accountSignal: new AbortController().signal,
        threadActions: {
          ensureThread: () => undefined,
          markPendingCreation: threadActions.markPendingCreation,
          clearPendingCreation: threadActions.clearPendingCreation,
        },
      });
      return settle;
    }

    it("waits for the thread before looking up or replaying the first message", async () => {
      recordChatSubmission(ACCOUNT, entry());
      const scenario = new ThreadRunScenario({
        lookup: async ({ submissionId }) => ({ kind: "not-seen", submissionId }),
      });
      const creation = resumeCreation(scenario);

      await mount(ACCOUNT, scenario, () => undefined);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      // The message shows, pending, and nothing has asked a server that has no thread yet.
      expect(scenario.turns()).toEqual([expect.objectContaining({ status: "pending" })]);
      expect(scenario.lookupRequests).toHaveLength(0);
      expect(scenario.appendRequests).toHaveLength(0);

      await act(async () => {
        creation.resolve({ id: THREAD_ID, originType: "fork" });
      });
      await act(async () => {
        await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
      });
      expect(scenario.lookupRequests).toEqual([
        expect.objectContaining({ threadId: THREAD_ID, submissionId: "sub-1" }),
      ]);
      await act(async () => {
        await vi.waitFor(() => expect(readChatSubmissions(ACCOUNT)).toEqual([]));
      });
      expect(scenario.turns()).toEqual([
        expect.objectContaining({ id: "turn-user", status: "complete" }),
      ]);
    });

    it("fails the message with Retry when creation fails, as a live send does", async () => {
      recordChatSubmission(ACCOUNT, entry());
      const scenario = new ThreadRunScenario();
      const creation = resumeCreation(scenario);
      const latest: { current: ChatSubmissionRecovery | null } = { current: null };
      await mount(ACCOUNT, scenario, (value) => {
        latest.current = value;
      });

      await act(async () => {
        creation.reject(new Error("offline"));
      });
      await act(async () => {
        await vi.waitFor(() => expect(latest.current?.rejected).toHaveLength(1));
      });
      expect(scenario.lookupRequests).toHaveLength(0);
      expect(scenario.turns()).toEqual([expect.objectContaining({ status: "error" })]);
      expect(latest.current?.recovered).toEqual([]);

      // Retry on the message waits for the fork, which still does not exist.
      const turnId = scenario.turns()[0]?.id ?? "";
      await act(async () => {
        await latest.current?.retry(turnId);
      });
      expect(scenario.appendRequests).toHaveLength(0);
      expect(latest.current?.rejected).toHaveLength(1);
    });
  });
});

describe("rejected draft ownership", () => {
  async function setupDraft(scenario = new ThreadRunScenario()) {
    const doc = plainComposerDoc("Compare ");
    doc.content?.[0]?.content?.push({
      type: "composerReference",
      attrs: {
        reference: {
          documentId: "01900000-0000-7000-8000-000000000001",
          uri: "manuscript://chapter.md",
          authority: { kind: "project", projectId: "01900000-0000-7000-8000-000000000002" },
          fileType: "markdown",
          label: "chapter.md",
          imageCapable: false,
          upload: null,
        },
      },
    });
    const envelope = serializeComposerDraft(doc, 7);
    let draft!: ReturnType<typeof useComposerSessionDraft>;
    const root = createRoot(document.createElement("div"));
    function Pane() {
      draft = useComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID });
      return null;
    }
    await act(() => root.render(<Pane />));
    let recovery!: ChatSubmissionRecovery;
    await mount(ACCOUNT, scenario, (value) => {
      recovery = value;
    });
    draft.updateDraft({ text: envelope.text, snapshot: envelope.draft });
    recordChatSubmission(ACCOUNT, {
      ...entry(),
      text: envelope.text,
      blocks: [...envelope.blocks],
      references: [...envelope.references],
      draft: envelope.draft,
    });
    draft.handoff();
    const row = scenario.store.getState().appendUserTurn(THREAD_ID, envelope.blocks);
    rememberSubmissionTurnId(ACCOUNT, "sub-1", row.id);
    return { envelope, draft, root, row, getRecovery: () => recovery };
  }

  it("transfers a structured rejection after the composer unmounts, before retirement, and survives remount/reload", async () => {
    const state = await setupDraft();
    await act(() => state.root.unmount());
    await cleanup?.();
    cleanup = undefined;
    await act(() => state.getRecovery().markRejected("sub-1", state.row.id));
    const reloaded = new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID })
      .initialDraft;
    expect(reloaded?.doc).toEqual(state.envelope.draft.doc);
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
    const remount = createRoot(document.createElement("div"));
    let remountedDraft: ReturnType<typeof useComposerSessionDraft>["initialDraft"] = null;
    function Pane() {
      remountedDraft = useComposerSessionDraft(ACCOUNT, {
        kind: "chat",
        id: THREAD_ID,
      }).initialDraft;
      return null;
    }
    await act(() => remount.render(<Pane />));
    expect(remountedDraft).toEqual(reloaded);
    await act(() => remount.unmount());
    // Reload reads the same structured authoring snapshot from storage.
    expect(reloaded && serializeComposerDraft(reloaded.doc).references).toEqual(
      state.envelope.references,
    );
  });

  it("removes a retired failed row on remount when its words already belong to the composer", async () => {
    const scenario = new ThreadRunScenario();
    const state = await setupDraft(scenario);
    await act(() => state.getRecovery().markRejected("sub-1", state.row.id));
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
    await act(() => state.root.unmount());
    await cleanup?.();
    cleanup = undefined;
    let recovery!: ChatSubmissionRecovery;
    await mount(ACCOUNT, scenario, (value) => {
      recovery = value;
    });
    expect(scenario.turns()).toEqual([]);
    expect(recovery.rejected).toEqual([]);
    expect(
      new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID }).initialDraft?.doc,
    ).toEqual(state.envelope.draft.doc);
  });

  it("reconciles a journal rejection on remount and returns its reference atoms before retirement", async () => {
    const state = await setupDraft();
    await act(() => state.root.unmount());
    await cleanup?.();
    cleanup = undefined;
    const scenario = new ThreadRunScenario({
      lookup: async ({ submissionId }) => ({ kind: "rejected", submissionId, code: "forbidden" }),
    });
    await mount(ACCOUNT, scenario, () => undefined);
    const reloaded = new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID })
      .initialDraft;
    expect(reloaded?.doc).toEqual(state.envelope.draft.doc);
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });

  it("does not replace later writing when rejection transfers ownership", async () => {
    const state = await setupDraft();
    await act(() => state.root.unmount());
    const remount = createRoot(document.createElement("div"));
    let remountedDraft!: ReturnType<typeof useComposerSessionDraft>;
    function Pane() {
      remountedDraft = useComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID });
      return null;
    }
    await act(() => remount.render(<Pane />));
    const later = serializeComposerDraft(plainComposerDoc("New writing"), 8);
    remountedDraft.updateDraft({ text: later.text, snapshot: later.draft });
    await act(() => state.getRecovery().markRejected("sub-1", state.row.id));
    await act(() => remount.unmount());
    expect(
      new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID }).initialDraft?.doc,
    ).toEqual(later.draft.doc);
    expect(readChatSubmissions(ACCOUNT)).toEqual([
      expect.objectContaining({ state: "rejected", draft: state.envelope.draft }),
    ]);
    await cleanup?.();
    cleanup = undefined;
    clearChatSubmissionRecoverySession();
    const reloadedScenario = new ThreadRunScenario();
    let reloadedRecovery!: ChatSubmissionRecovery;
    await mount(ACCOUNT, reloadedScenario, (value) => {
      reloadedRecovery = value;
    });
    expect(reloadedRecovery.rejected[0]?.fingerprint.draft).toEqual(state.envelope.draft);
    expect(reloadedScenario.lookupRequests).toHaveLength(0);
    expect(reloadedScenario.appendRequests).toHaveLength(0);
  });

  it("Retry sends the journal fingerprint and leaves newer draft and references alone", async () => {
    const scenario = new ThreadRunScenario();
    const state = await setupDraft(scenario);
    const later = serializeComposerDraft(plainComposerDoc("New writing"), 8);
    state.draft.updateDraft({ text: later.text, snapshot: later.draft });
    await act(() => state.getRecovery().markRejected("sub-1", state.row.id));
    await act(() => state.getRecovery().retry(state.row.id));
    expect(scenario.appendRequests[0]?.data).toMatchObject({
      text: state.envelope.text,
      references: state.envelope.references,
      blocks: state.envelope.blocks,
    });
    await act(() => state.root.unmount());
    expect(
      new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID }).initialDraft?.doc,
    ).toEqual(later.draft.doc);
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });

  it("Edit prepends rejected words and reference atoms to newer writing and retires the journal", async () => {
    const state = await setupDraft();
    const later = serializeComposerDraft(plainComposerDoc("New writing"), 8);
    state.draft.updateDraft({ text: later.text, snapshot: later.draft });
    await act(() => state.getRecovery().markRejected("sub-1", state.row.id));
    await act(() => expect(state.getRecovery().edit("sub-1")).toBe(true));
    await act(() => state.root.unmount());
    const restored = new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID })
      .initialDraft;
    expect(restored?.doc.content).toEqual([
      ...(state.envelope.draft.doc.content ?? []),
      ...(later.draft.doc.content ?? []),
    ]);
    expect(restored && serializeComposerDraft(restored.doc).references).toEqual(
      state.envelope.references,
    );
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
  });

  it("Edit fills an empty composer from a retained rejection", async () => {
    const state = await setupDraft();
    state.draft.updateDraft({
      text: "new",
      snapshot: serializeComposerDraft(plainComposerDoc("new")).draft,
    });
    await act(() => state.getRecovery().markRejected("sub-1", state.row.id));
    state.draft.updateDraft({
      text: "",
      snapshot: serializeComposerDraft(plainComposerDoc("")).draft,
    });
    await act(() => expect(state.getRecovery().edit("sub-1")).toBe(true));
    expect(
      new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID }).initialDraft?.doc,
    ).toEqual(state.envelope.draft.doc);
    expect(readChatSubmissions(ACCOUNT)).toEqual([]);
    await act(() => state.root.unmount());
  });

  it.each([
    false,
    true,
  ])("preserves authoring during Retry even when a remounted editor reuses its local revision (same snapshot: %s)", async (sameSnapshot) => {
    const gate = scenarioGate<SendMessageResponse>();
    const scenario = new ThreadRunScenario({ append: () => gate.promise });
    const state = await setupDraft(scenario);
    await act(() => state.getRecovery().markRejected("sub-1", state.row.id));
    state.draft.updateDraft({ text: state.envelope.text, snapshot: state.envelope.draft });
    window.dispatchEvent(new Event("pagehide"));
    // Before admission, rejected words belong to the per-tab draft owner.
    let retry!: Promise<void>;
    await act(async () => {
      retry = state.getRecovery().retry(state.row.id);
      await vi.waitFor(() => expect(scenario.appendRequests).toHaveLength(1));
    });
    expect(
      new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID }).initialDraft,
    ).toBeNull();
    const later = sameSnapshot
      ? state.envelope
      : serializeComposerDraft(plainComposerDoc("Writing during Retry"), 8);
    state.draft.updateDraft({ text: later.text, snapshot: later.draft });
    gate.resolve(defaultSendResponse());
    await act(() => retry);
    await act(() => state.root.unmount());
    expect(
      new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID }).initialDraft?.doc,
    ).toEqual(later.draft.doc);
  });

  it.each([
    false,
    true,
  ])("accepted Retry clears only the unchanged rejected draft (edited: %s)", async (edited) => {
    const state = await setupDraft();
    await act(() => state.getRecovery().markRejected("sub-1", state.row.id));
    // The pre-fix mounted rejection callback republished this same visible draft.
    state.draft.updateDraft({ text: state.envelope.text, snapshot: state.envelope.draft });
    if (edited) {
      const later = serializeComposerDraft(plainComposerDoc("New writing"), 8);
      state.draft.updateDraft({ text: later.text, snapshot: later.draft });
    }
    await act(() => state.getRecovery().retry(state.row.id));
    await act(() => state.root.unmount());
    const reloaded = new ComposerSessionDraft(ACCOUNT, { kind: "chat", id: THREAD_ID })
      .initialDraft;
    expect(reloaded?.doc ?? null).toEqual(edited ? plainComposerDoc("New writing") : null);
  });
});
