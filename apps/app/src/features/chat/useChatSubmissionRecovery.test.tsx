// @vitest-environment jsdom

/** Existing-thread reload recovery from the durable submission journal. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExistingThreadChatSubmission } from "@/client/chat-submissions";
import {
  bindChatSubmissions,
  readChatSubmissions,
  recordChatSubmission,
} from "@/client/chat-submissions";
import { ThreadRunScenario } from "@/client/copilot/test-support/ThreadRunScenario";
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
});
