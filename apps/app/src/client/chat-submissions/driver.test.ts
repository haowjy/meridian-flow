/** Submission ownership, stable-id recovery and durable refusal contracts. */
import type { Thread } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { classifyWriteFailure } from "@/client/copilot/ThreadRunController";
import {
  defaultSendResponse,
  scenarioGate,
  ThreadRunScenario,
} from "@/client/copilot/test-support/ThreadRunScenario";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { MemorySubmissionLock } from "./adapters/memory-lock";
import { ChatSubmissionDriver, type SubmissionDriverOptions } from "./driver";
import type { ChatSubmission } from "./store";

function record(): ChatSubmission {
  const envelope = serializeComposerDraft(plainComposerDoc("Keep the opening"));
  return {
    ...envelope,
    blocks: [...envelope.blocks],
    references: [...envelope.references],
    activatedSkillSlugs: [...envelope.activatedSkillSlugs],
    recordId: "record-1",
    submissionId: "sub-1",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: "2026-10-11T10:00:00Z",
    creation: {
      title: "Opening",
      workId: null,
      agentName: "General",
      agentSlug: "general",
      agentSelection: { catalogEntryId: "general", definitionRevisionId: "rev" },
    },
  };
}
function rig(options: ConstructorParameters<typeof ThreadRunScenario>[0] = {}) {
  const scenario = new ThreadRunScenario(options);
  const records = new Map<string, ChatSubmission>([["record-1", record()]]);
  const rows = new Map<string, string>();
  const lock = new MemorySubmissionLock();
  const mounts: AbortController[] = [];
  let creates = 0;
  const mount = (overrides: Partial<SubmissionDriverOptions> = {}) => {
    const life = new AbortController();
    mounts.push(life);
    const session = {};
    scenario.controller.beginRecoverySession(session);
    const owner = new ChatSubmissionDriver({
      accountId: "account-1",
      signal: life.signal,
      isCurrent: () => true,
      session,
      lock,
      controller: scenario.controller,
      journal: {
        entries: () => [...records.values()],
        record: (entry) => {
          records.set(entry.recordId, entry);
          return true;
        },
        retire: (id) => records.delete(id),
      },
      whenDerived: async () => true,
      create: async () => {
        creates++;
        return { id: "thread_1" } as Thread;
      },
      created: () => {},
      row: (entry) => {
        let id = rows.get(entry.recordId);
        if (!id) {
          id = scenario.store.getState().appendUserTurn(entry.threadId, entry.blocks).id;
          rows.set(entry.recordId, id);
        }
        return id;
      },
      status: (entry, status) => {
        let id = rows.get(entry.recordId);
        if (!id) {
          id = scenario.store.getState().appendUserTurn(entry.threadId, entry.blocks).id;
          rows.set(entry.recordId, id);
        }
        if (id) scenario.store.getState().patchTurnStatus(entry.threadId, id, status);
      },
      takeFresh: () => false,
      transferForEdit: () => false,
      edited: () => {},
      ...overrides,
    });
    return { owner, life };
  };
  return {
    scenario,
    records,
    mount,
    creates: () => creates,
    dispose: () => {
      for (const life of mounts) life.abort();
      scenario.controller.dispose();
    },
  };
}

it("classifies the write failure table identically for creation and admission", () => {
  const cases: [unknown, string][] = [
    [new HttpResponseError("work_unavailable", 400, null), "rejected"],
    [new HttpResponseError("forbidden", 403, null), "rejected"],
    [new HttpResponseError("missing", 404, null), "rejected"],
    [new HttpResponseError("retired", 409, null), "rejected"],
    [new HttpResponseError("admission_pending", 409, null), "ambiguous"],
    [new HttpResponseError("committed then failed", 500, null), "ambiguous"],
    [new TypeError("Failed to fetch"), "ambiguous"],
    [new DOMException("Timed out", "TimeoutError"), "ambiguous"],
  ];
  for (const [error, expected] of cases) expect(classifyWriteFailure(error)).toBe(expected);
});

describe("the journal driver", () => {
  it("keeps a create abort on the writer row; Retry creates and admits once", async () => {
    const r = rig();
    let attempts = 0;
    try {
      const { owner } = r.mount({
        create: async () => {
          if (attempts++ === 0) throw new TypeError("Aborted transport");
          return { id: "thread_1" } as Thread;
        },
      });
      await owner.drive("thread_1");
      expect(r.records.get("record-1")?.state).toBeUndefined();
      expect(r.scenario.turns().map((turn) => turn.role)).toEqual(["user"]);
      expect(r.scenario.appendRequests).toHaveLength(0);
      await owner.retry("sub-1");
      expect(attempts).toBe(2);
      expect(r.scenario.appendRequests).toHaveLength(1);
      expect(r.scenario.turns().map((turn) => turn.role)).toEqual(["user"]);
      expect(r.records.size).toBe(0);
    } finally {
      r.dispose();
    }
  });
  it("persists a create refusal and never re-drives it on mount", async () => {
    const r = rig();
    let attempts = 0;
    try {
      await r
        .mount({
          create: async () => {
            attempts++;
            throw new HttpResponseError("work_unavailable", 400, null);
          },
        })
        .owner.drive("thread_1");
      expect(r.records.get("record-1")?.state).toBe("rejected");
      await r.mount().owner.drive("thread_1");
      expect(attempts).toBe(1);
      expect(r.creates()).toBe(0);
      expect(r.scenario.appendRequests).toHaveLength(0);
    } finally {
      r.dispose();
    }
  });
  it("releases an abandoned owner so a waiting mount takes over", async () => {
    const r = rig();
    const held = scenarioGate<Thread>();
    const started = scenarioGate<void>();
    try {
      const first = r.mount({
        create: () => {
          started.resolve();
          return held.promise;
        },
      });
      const pending = first.owner.drive("thread_1");
      await started.promise;
      const next = r.mount();
      const takeover = next.owner.drive("thread_1");
      first.life.abort();
      await pending;
      await takeover;
      expect(r.creates()).toBe(1);
      expect(r.scenario.appendRequests).toHaveLength(1);
      expect(r.records.size).toBe(0);
      held.resolve({ id: "thread_1" } as Thread);
    } finally {
      r.dispose();
    }
  });
  it("Retry bridges an earlier acceptance after a refusal, without another POST", async () => {
    const r = rig({
      lookup: async ({ submissionId }) => ({
        kind: "accepted",
        submissionId,
        ...defaultSendResponse(),
      }),
    });
    try {
      r.records.set("record-1", { ...record(), creation: undefined, state: "rejected" });
      const row = r.scenario.store.getState().appendUserTurn("thread_1", record().blocks);
      const owner = r.mount({
        row: () => row.id,
        status: (_entry, status) =>
          r.scenario.store.getState().patchTurnStatus("thread_1", row.id, status),
      }).owner;
      await owner.retry("sub-1");
      expect(r.scenario.appendRequests).toHaveLength(0);
      expect(r.records.size).toBe(0);
      expect(r.scenario.turns().map((turn) => turn.id)).toEqual([defaultSendResponse().userTurnId]);
    } finally {
      r.dispose();
    }
  });
});

it("closing another pane preserves an in-flight admission", async () => {
  const gate = scenarioGate<ReturnType<typeof defaultSendResponse>>();
  const started = scenarioGate<void>();
  const r = rig({
    append: () => {
      started.resolve();
      return gate.promise;
    },
  });
  r.records.set("record-1", { ...record(), creation: undefined });
  try {
    const owner = r.mount({ takeFresh: () => true }).owner;
    const pending = owner.drive("thread_1");
    await started.promise;
    r.scenario.controller.teardown("another-thread");
    gate.resolve(defaultSendResponse());
    await pending;
    expect(r.records.size).toBe(0);
    expect(r.scenario.appendRequests).toHaveLength(1);
  } finally {
    r.dispose();
  }
});

it.each([
  "refusal",
  "retry",
  "remint",
  "creation",
] as const)("%s rewrite refusal leaves the attempted row failed without changing durable identity", async (transition) => {
  const r = rig({
    lookup: async ({ submissionId }) => ({ kind: "rejected", submissionId, code: "refused" }),
  });
  const original = {
    ...record(),
    creation: transition === "creation" || transition === "refusal" ? record().creation : undefined,
    state: transition === "retry" ? ("rejected" as const) : undefined,
  };
  r.records.set("record-1", original);
  const statuses: Array<{ status: string; local?: boolean }> = [];
  try {
    const owner = r.mount({
      journal: { entries: () => [...r.records.values()], record: () => false, retire: () => false },
      status: (_entry, status, local) => {
        statuses.push({ status, local });
      },
      ...(transition === "refusal"
        ? {
            create: async () => {
              throw new HttpResponseError("refused", 400, null);
            },
          }
        : {}),
    }).owner;
    if (transition === "retry" || transition === "remint") await owner.retry("sub-1");
    else await owner.drive("thread_1");
    expect(statuses.at(-1)).toEqual({ status: "error", local: true });
    expect(r.records.get("record-1")).toEqual(original);
    expect(r.scenario.appendRequests).toHaveLength(0);
  } finally {
    r.dispose();
  }
});

it("reports a projection exception and fails only the attempted record", async () => {
  const reported = vi.fn();
  vi.stubGlobal("reportError", reported);
  const r = rig();
  r.records.set("record-1", { ...record(), creation: undefined });
  r.records.set("record-2", {
    ...record(),
    recordId: "record-2",
    submissionId: "sub-2",
    creation: undefined,
    createdAt: "2026-10-11T11:00:00Z",
  });
  const statuses: string[] = [];
  const cause = new Error("row invariant");
  try {
    await r
      .mount({
        row: () => {
          throw cause;
        },
        status: (entry, status) => {
          if (status === "error") statuses.push(entry.recordId);
        },
      })
      .owner.drive("thread_1");
    expect(reported).toHaveBeenCalledWith(cause);
    expect(statuses).toEqual(["record-1"]);
  } finally {
    r.dispose();
    vi.unstubAllGlobals();
  }
});
