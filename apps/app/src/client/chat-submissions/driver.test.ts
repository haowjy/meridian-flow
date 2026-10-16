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
    seq: 1,
    creation: {
      title: "Opening",
      workId: null,
      workAiWriteMode: "direct",
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
      postControl: async () => ({
        id: "control",
        queued: false,
        pending: null,
        turnId: "switch-turn",
        seq: "1",
        mode: "direct",
        runState: {
          version: "0",
          items: [],
          sentThrough: 0,
          execution: null,
          mode: "direct",
          blocked: null,
        },
      }),
      status: (entry, status) => {
        if (entry.control) return;
        let id = rows.get(entry.recordId);
        if (!id) {
          id = scenario.store.getState().appendUserTurn(entry.threadId, entry.blocks).id;
          rows.set(entry.recordId, id);
        }
        if (id) scenario.store.getState().patchTurnStatus(entry.threadId, id, status);
      },
      takeFresh: () => false,
      transferForEdit: () => false,
      transferReceived: () => false,
      finished: () => {},
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
  const statuses: Array<{ status: string; local?: "unsaved" | "lost" }> = [];
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
    expect(statuses.at(-1)).toEqual({ status: "error", local: "unsaved" });
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
    seq: 2,
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

it("a lock failure reports its cause and fails only the waiting attempt", async () => {
  const reported = vi.fn();
  vi.stubGlobal("reportError", reported);
  const r = rig();
  const cause = new Error("lock adapter unavailable");
  const statuses: string[] = [];
  try {
    await r
      .mount({
        lock: {
          run: async () => {
            throw cause;
          },
        },
        status: (entry, status) => {
          if (status === "error") statuses.push(entry.recordId);
        },
      })
      .owner.retry("sub-1");
    expect(reported).toHaveBeenCalledWith(cause);
    expect(statuses).toEqual(["record-1"]);
  } finally {
    r.dispose();
    vi.unstubAllGlobals();
  }
});

it("lookup and retirement request refusals never authorize identity change or transfer", async () => {
  const refusal = async () => {
    throw new HttpResponseError("auth unavailable", 401, null);
  };
  const test = rig({ lookup: refusal, retire: refusal });
  const initial = { ...record(), creation: undefined, state: "rejected" as const };
  test.records.set(initial.recordId, initial);
  const transfer = vi.fn(() => true);
  const { owner: driver } = test.mount({ transferForEdit: transfer });
  await driver.retry(initial.submissionId);
  expect(test.records.get(initial.recordId)?.submissionId).toBe(initial.submissionId);
  test.records.set(initial.recordId, initial);
  await driver.edit(initial.submissionId);
  expect(transfer).not.toHaveBeenCalled();
  test.dispose();
});

it("a failed successor creation rewrite also fails its attempted predecessor", async () => {
  const test = rig();
  test.records.set("record-2", {
    ...record(),
    recordId: "record-2",
    submissionId: "sub-2",
    createdAt: "2026-10-11T10:00:01Z",
    seq: 2,
  });
  const status = vi.fn();
  const { owner } = test.mount({
    takeFresh: () => true,
    status,
    journal: {
      entries: () => [...test.records.values()],
      record: (entry) => {
        if (entry.recordId === "record-2") return false;
        test.records.set(entry.recordId, entry);
        return true;
      },
      retire: (id) => test.records.delete(id),
    },
  });
  await owner.drive("thread_1");
  expect(test.scenario.appendRequests).toHaveLength(0);
  expect(status).toHaveBeenCalledWith(
    expect.objectContaining({ recordId: "record-1" }),
    "error",
    true,
  );
  test.dispose();
});

it("stops on owner-attested deletion from send, lookup or retire, without rejecting or retrying the row", async () => {
  const { MeridianApiError } = await import("@/client/api/meridian-error");
  const deleted = new MeridianApiError(
    {
      code: "thread_deleted",
      message: "deleted",
      retryable: false,
      source: "system",
      details: { authenticatedUserId: "account-1" },
    },
    404,
  );
  for (const operation of ["send", "lookup", "retire"] as const) {
    const r = rig({
      append: async () => {
        throw deleted;
      },
      lookup: async () => {
        throw deleted;
      },
      retire: async () => {
        throw deleted;
      },
    });
    const record = r.records.get("record-1");
    if (!record) throw new Error("Fixture missing");
    r.records.set(record.recordId, {
      ...record,
      creation: undefined,
      state: operation === "retire" ? "rejected" : undefined,
    });
    let disposition = "";
    try {
      const { owner } = r.mount({
        takeFresh: () => operation === "send",
        deleted: async (_entry, reason) => {
          disposition = reason;
          return true;
        },
      });
      if (operation === "retire") await owner.edit("sub-1");
      else await owner.drive("thread_1");
      expect(disposition).toBe("deleted");
      expect(r.records.get("record-1")?.state).toBe(
        operation === "retire" ? "rejected" : undefined,
      );
      const requests = r.scenario.appendRequests.length;
      await owner.retry("sub-1");
      await owner.drive("thread_1");
      expect(r.scenario.appendRequests).toHaveLength(requests);
    } finally {
      r.dispose();
    }
  }
});

it.each([
  "retry",
  "edit",
  "wake",
])("incomplete deletion settles Couldn't send and can finish on %s", async (action) => {
  const r = rig();
  const entry = r.records.get("record-1");
  if (!entry) throw new Error("Missing fixture");
  r.records.set(entry.recordId, { ...entry, creation: undefined });
  let complete = false;
  const deleted = vi.fn(async () => complete);
  const status = vi.fn();
  const outcome = async () => ({ kind: "deleted" as const, submissionId: "sub-1" });
  const { owner } = r.mount({
    status,
    deleted,
    controller: {
      recoverSubmission: outcome,
      lookupSubmission: outcome,
      retireSubmission: outcome,
    },
  });
  await owner.drive("thread_1");
  expect(status).toHaveBeenLastCalledWith(
    expect.objectContaining({ recordId: "record-1" }),
    "error",
  );
  complete = true;
  if (action === "retry") await owner.retry("sub-1");
  else if (action === "edit") await owner.edit("sub-1");
  else await owner.drive("thread_1");
  expect(deleted).toHaveBeenCalledTimes(2);
  r.dispose();
});

it("later Sends behind incomplete deletion settle every row without admission", async () => {
  const r = rig();
  const lookup = vi.fn(async () => ({ kind: "deleted" as const, submissionId: "sub-1" }));
  const admit = vi.fn();
  const original = { ...record(), creation: undefined };
  r.records.set(original.recordId, original);
  let writable = false;
  const { owner } = r.mount({
    controller: { lookupSubmission: lookup, recoverSubmission: admit, retireSubmission: admit },
    deleted: async () => {
      if (!writable) return false;
      r.records.clear();
      return true;
    },
  });
  try {
    await owner.drive(original.threadId);
    const later = {
      ...original,
      recordId: "record-2",
      submissionId: "sub-2",
      createdAt: "2026-10-11T11:00:00Z",
      seq: 2,
    };
    r.records.set(later.recordId, later);
    await owner.drive(original.threadId);
    expect([...r.records.values()].map((entry) => entry.state)).toEqual(["rejected", "rejected"]);
    expect(r.scenario.turns().map((turn) => turn.status)).toEqual(["error", "error"]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(admit).not.toHaveBeenCalled();
    writable = true;
    await owner.retry(later.submissionId);
    expect(r.records.size).toBe(0);
    expect(r.scenario.appendRequests).toHaveLength(0);
  } finally {
    r.dispose();
  }
});

it("Retry and Edit finish incomplete deletion before handling a received first send", async () => {
  const r = rig();
  let received = false;
  let removable = false;
  const { owner } = r.mount({
    create: async () => {
      const { MeridianApiError } = await import("@/client/api/meridian-error");
      throw new MeridianApiError(
        {
          code: "thread_deleted",
          message: "deleted",
          retryable: false,
          source: "system",
          details: { authenticatedUserId: "account-1", projectDeleted: false },
        },
        404,
      );
    },
    transferReceived: () => received,
    deleted: async () => {
      received = true;
      if (!removable) return false;
      r.records.clear();
      return true;
    },
  });
  try {
    await owner.drive("thread_1");
    expect(received).toBe(true);
    expect(r.records.get("record-1")?.state).toBe("rejected");
    await owner.retry("sub-1");
    await owner.edit("sub-1");
    removable = true;
    await owner.retry("sub-1");
    expect(r.records.size).toBe(0);
    expect(r.scenario.lookupRequests).toHaveLength(0);
    expect(r.scenario.appendRequests).toHaveLength(0);
  } finally {
    r.dispose();
  }
});

const SWITCH_AT = "2026-10-11T10:01:00Z";
describe("write-mode switches in the journal", () => {
  const switchRecord = (seq: number): ChatSubmission => ({
    recordId: "switch-1",
    submissionId: "switch-1",
    threadId: "thread_1",
    projectId: "project-1",
    createdAt: SWITCH_AT,
    seq,
    text: "",
    blocks: [],
    references: [],
    activatedSkillSlugs: [],
    control: { kind: "write_mode", mode: "draft" },
  });
  const messageAfter = (seq: number): ChatSubmission => {
    const { creation: _creation, ...rest } = record();
    // Same millisecond as the switch: only `seq` says which the writer did first.
    return { ...rest, recordId: "record-2", submissionId: "sub-2", seq, createdAt: SWITCH_AT };
  };

  it("posts a reloaded switch between the messages around it, in the order the writer acted", async () => {
    const r = rig();
    const order: string[] = [];
    try {
      // Storage enumerates the later message first; the switch still goes before it.
      r.records.set("record-2", messageAfter(3));
      r.records.set("switch-1", switchRecord(2));
      const { owner } = r.mount({
        postControl: async () => {
          order.push(`switch after ${r.scenario.appendRequests.length} message(s)`);
          return {
            id: "switch-1",
            turnId: "switch-turn",
            runState: {
              version: "0",
              items: [],
              sentThrough: 0,
              execution: null,
              mode: "direct",
              blocked: null,
            },
          };
        },
      });
      await owner.drive("thread_1");
      expect(order).toEqual(["switch after 1 message(s)"]);
      expect(r.scenario.appendRequests).toHaveLength(2);
      // The answer is stamped on the record for every tab to read; it is not posted again.
      expect([...r.records.keys()]).toEqual(["switch-1"]);
      expect(r.records.get("switch-1")?.answer?.runState).toMatchObject({
        version: "0",
        mode: "direct",
        items: [],
      });
      await owner.drive("thread_1");
      expect(order).toHaveLength(1);
    } finally {
      r.dispose();
    }
  });

  it("holds what comes after a refused switch until Withdraw or an admitted Retry", async () => {
    const r = rig();
    let refuse = true;
    let lost = false;
    try {
      r.records.clear();
      r.records.set("switch-1", switchRecord(2));
      r.records.set("record-2", messageAfter(3));
      const { owner } = r.mount({
        postControl: async () => {
          if (lost) throw new HttpResponseError("busy", 503, null);
          if (refuse) throw new HttpResponseError("work_unavailable", 400, null);
          return {
            id: "switch-1",
            turnId: "switch-turn",
            runState: {
              version: "0",
              items: [],
              sentThrough: 0,
              execution: null,
              mode: "direct",
              blocked: null,
            },
          };
        },
      });
      await owner.drive("thread_1");
      expect(r.records.get("switch-1")?.state).toBe("rejected");
      expect(r.scenario.appendRequests).toHaveLength(0);
      refuse = false;
      await owner.retry("switch-1");
      expect(r.scenario.appendRequests).toHaveLength(1);
      expect(r.records.get("switch-1")?.answer).toBeDefined();
      r.records.delete("switch-1");
      // Withdraw is the other way out: it never reached the server, so the journal drops it.
      refuse = true;
      r.records.set("switch-1", switchRecord(4));
      r.records.set("record-3", {
        ...messageAfter(5),
        recordId: "record-3",
        submissionId: "sub-3",
      });
      await owner.drive("thread_1");
      expect(r.scenario.appendRequests).toHaveLength(1);
      expect(await owner.withdrawControl("switch-1", "thread_1")).toBe("removed");
      expect(r.scenario.appendRequests).toHaveLength(2);
      // One whose answer was lost may be on the server: it is marked posted before the
      // request leaves, keeps its place, and a local Withdraw leaves it for Retry.
      lost = true;
      r.records.clear();
      r.records.set("switch-1", switchRecord(6));
      r.records.set("record-3", {
        ...messageAfter(7),
        recordId: "record-3",
        submissionId: "sub-3",
      });
      await owner.drive("thread_1");
      expect(r.records.get("switch-1")).toMatchObject({ posted: true });
      expect(r.records.get("switch-1")?.state).toBeUndefined();
      expect(await owner.withdrawControl("switch-1", "thread_1")).toBe("kept");
      expect(r.records.has("switch-1")).toBe(true);
      expect(r.scenario.appendRequests).toHaveLength(2);
    } finally {
      r.dispose();
    }
  });
});
