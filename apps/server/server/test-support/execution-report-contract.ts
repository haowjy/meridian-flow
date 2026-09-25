/** Bounded adapter parity; physical locks, ownership SQL and deletion stay in the DB suites. */
import { describe, expect, it } from "vitest";
import type { ExecutionScenario } from "./execution-scenario.js";

export function executionReportContract(create: () => Promise<ExecutionScenario>) {
  describe("execution report adapter contract", () => {
    it("preserves admission identity, capture snapshots and immutable terminal/publication replay", async () => {
      const s = await create();
      const { ids, repos } = s;
      await s.admit();
      await s.admit();
      const other = await repos.threads.createSubagent({
        userId: ids.user,
        projectId: ids.project,
        parentThreadId: ids.caller,
        rootThreadId: ids.caller,
        spawnDepth: 1,
      });
      await expect(s.admit({ childThreadId: other.id, handle: other.ref ?? "" })).rejects.toThrow();
      await expect(s.admit({ toolCallId: "another-invocation" })).rejects.toThrow();
      await expect(s.admit({ assistantTurnId: ids.childUserTurn })).rejects.toThrow();
      const capture = { summary: "saved", payload: { nested: [1, true, null, "text"] } };
      await s.capture(capture);
      capture.payload.nested.push("external mutation");
      const savedCapture = { summary: "saved", payload: { nested: [1, true, null, "text"] } };
      expect((await s.read())?.capture).toEqual(savedCapture);
      await s.capture(savedCapture);
      await expect(s.capture(savedCapture, "different-tool-call")).rejects.toThrow();
      const saved = await s.finalize(savedCapture);
      expect(saved.publication).toBe("pending");
      saved.summary = "external mutation";
      expect((await s.read())?.summary).toBe("saved");
      expect(await s.admit()).toMatchObject({ summary: "saved" });
      expect(await s.finalize(savedCapture)).toEqual(await s.read());
      await expect(s.finalize({ ...savedCapture, summary: "changed" })).rejects.toThrow();
      await expect(
        s.finalize({ ...savedCapture, outcome: "failed", reason: "budget" }),
      ).rejects.toThrow();
      expect(await repos.executionReports.listPendingPublication(10)).toContainEqual({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        callerThreadId: ids.caller,
      });
      await repos.transaction(async () => {
        expect(
          await repos.executionReports.lockPendingPublication(ids.child, ids.execution),
        ).toMatchObject({ publication: "pending" });
        await repos.executionReports.markPublished(ids.child, ids.execution, "published");
      });
      expect(await s.finalize(savedCapture)).toMatchObject({
        publication: "published",
        summary: "saved",
      });
      expect(await s.capture(savedCapture)).toMatchObject({ publication: "published" });
      expect(await repos.executionReports.listPendingPublication(10)).toEqual([]);
    });

    it.each([
      {},
      { payload: null },
      { payload: '{"nested":[1,true,null,"text"]}' },
    ])("preserves payload presence and JSON scalar identity: %j", async (payload) => {
      const s = await create();
      await s.admit({
        origin: "thread_run",
        deliveryMode: "none",
        callerThreadId: null,
        callerTurnId: null,
        toolCallId: null,
        cardBlockId: null,
      });
      await s.capture({ summary: "saved", ...payload });
      expect((await s.read())?.capture).toEqual({ summary: "saved", ...payload });
      expect(await s.finalize(payload)).toMatchObject({ publication: "none" });
      expect((await s.read())?.payload).toEqual(payload.payload);
      if (typeof payload.payload === "string")
        await expect(s.finalize({ payload: JSON.parse(payload.payload) })).rejects.toThrow();
      await expect(
        s.finalize({ payload: payload.payload === null ? undefined : null }),
      ).rejects.toThrow();
    });

    it("rolls back each supported repository phase without erasing committed predecessors", async () => {
      const s = await create();
      const phases = [
        { write: () => s.admit(), state: null },
        { write: () => s.capture({ summary: "saved" }), state: { capture: null } },
        { write: () => s.finalize(), state: { outcome: null, capture: { summary: "saved" } } },
        {
          write: () =>
            s.repos.executionReports.markPublished(s.ids.child, s.ids.execution, "published"),
          state: { publication: "pending" },
        },
      ];
      for (const { write, state } of phases) {
        await expect(
          s.repos.transaction(async () => {
            await write();
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        if (state === null) expect(await s.read()).toBeNull();
        else expect(await s.read()).toMatchObject(state);
        await write();
      }
      expect(await s.read()).toMatchObject({ summary: "saved", publication: "published" });
    });
  });
}
