import { describe, expect, it } from "vitest";
import { ServerRestartingError } from "../loop/abort-reasons.js";
import type { TurnRunner } from "../loop/turn-runner.js";
import { createAdmissionTurnStarter } from "./admission-turn-starter.js";
import type { AdmissionPersistencePort } from "./drizzle-admission-records.js";
import { type AdmissionRecord, createUserTurnAdmission } from "./user-turn-admission.js";

describe("admission turn starter", () => {
  it("releases a shutdown-refused reservation so the same submission can be admitted", async () => {
    const recordsByKey = new Map<string, AdmissionRecord>();
    const keyFor = (threadId: string, submissionId: string) => `${threadId}:${submissionId}`;
    const records: AdmissionPersistencePort = {
      async lookup(threadId, submissionId) {
        return recordsByKey.get(keyFor(threadId, submissionId)) ?? null;
      },
      async reserve(input) {
        const key = keyFor(input.threadId, input.submissionId);
        const existing = recordsByKey.get(key);
        if (existing) return { kind: "winner", record: existing };
        recordsByKey.set(key, {
          state: "pending",
          fingerprint: input.fingerprint,
          claimExpiresAt: input.claimExpiresAt,
        });
        return { kind: "reserved" };
      },
      async releasePending(input) {
        const key = keyFor(input.threadId, input.submissionId);
        const existing = recordsByKey.get(key);
        if (existing?.state === "pending" && existing.fingerprint === input.fingerprint) {
          recordsByKey.delete(key);
        }
      },
      async reject(input) {
        const rejected = {
          state: "rejected" as const,
          fingerprint: input.fingerprint,
          code: input.code,
        };
        recordsByKey.set(keyFor(input.threadId, input.submissionId), rejected);
        return rejected;
      },
      async recoverExpiredPending({ threadId, submissionId }) {
        return recordsByKey.get(keyFor(threadId, submissionId)) ?? null;
      },
      async retire(input) {
        return { kind: "retired", submissionId: input.submissionId, code: "retired" };
      },
      async accept(input) {
        recordsByKey.set(keyFor(input.response.threadId, input.response.submissionId), {
          state: "accepted",
          fingerprint: input.fingerprint,
          response: input.response,
        });
        return { kind: "accepted", response: input.response };
      },
    };

    let startCount = 0;
    const runner = {
      assertAccepting() {},
      async startTurn(input: {
        threadId: string;
        admissionIdentity?: {
          onAccepted(response: {
            kind: "accepted";
            threadId: string;
            submissionId: string;
            userTurnId: string;
            assistantTurnId: string;
            resumeAfterSeq: string;
            snapshotFloorNextSeq: string;
          }): Promise<void>;
        };
      }) {
        startCount += 1;
        if (startCount === 1) throw new ServerRestartingError();
        const started = {
          userTurnId: "user-turn",
          assistantTurnId: "assistant-turn",
          resumeAfterSeq: "0",
          snapshotFloorNextSeq: "1",
        };
        await input.admissionIdentity?.onAccepted({
          kind: "accepted",
          threadId: input.threadId,
          submissionId: "same-submission",
          ...started,
        });
        return started;
      },
    } as unknown as TurnRunner;
    const starter = createAdmissionTurnStarter({
      runner,
      records,
      async consumeUploads() {},
      async attachDocument() {},
    });
    const admission = createUserTurnAdmission({
      records,
      runOwnership: {
        async tryAcquire() {
          return null;
        },
      } as never,
      availability: {
        async lookup({ projectId }) {
          return { projectId, resolutionId: "empty", resolutions: [] };
        },
      },
      async threadProject() {
        return "project-id";
      },
      starter,
    });
    const request = {
      actorUserId: "user-id" as never,
      threadId: "thread-id" as never,
      submissionId: "same-submission",
      text: "retry after restart",
      blocks: [{ type: "text" as const, text: "retry after restart" }],
      references: [],
    };

    await expect(admission.admit(request)).rejects.toBeInstanceOf(ServerRestartingError);
    expect(await records.lookup(request.threadId, request.submissionId)).toBeNull();
    await expect(admission.admit(request)).resolves.toMatchObject({
      kind: "accepted",
      submissionId: request.submissionId,
    });
    expect(startCount).toBe(2);
    expect(await records.lookup(request.threadId, request.submissionId)).toMatchObject({
      state: "accepted",
    });
  });
});
