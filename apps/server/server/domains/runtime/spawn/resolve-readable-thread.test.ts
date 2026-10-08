/** Connected history authority is shared by every inspection tool. */
import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { resolveReadableThread } from "./resolve-readable-thread.js";

const rows = [
  { id: "root", ref: "c1" },
  { id: "fork", ref: "c2", originType: "fork" },
  { id: "handoff", ref: "c3", originType: "handoff" },
  { id: "child", ref: "p1", parentThreadId: "root" },
  { id: "grandchild", ref: "p2", parentThreadId: "child" },
  { id: "forkChild", ref: "p3", parentThreadId: "fork" },
  { id: "stranger", ref: "c4", rootThreadId: "stranger" },
  { id: "elsewhere", ref: "c5", projectId: "elsewhere" },
  { id: "trashed", ref: "c6", deletedAt: "2026-01-01" },
  { id: "otherOwner", ref: "c7", userId: "other" },
].map(
  (row) =>
    ({
      projectId: "project",
      userId: "user",
      rootThreadId: "root",
      deletedAt: null,
      ...row,
    }) as Thread,
);
const threads = {
  async findLiveByProjectRef(projectId: string, ref: string) {
    return (
      rows.find((row) => row.projectId === projectId && row.ref === ref && !row.deletedAt) ?? null
    );
  },
};
describe("resolveReadableThread", () => {
  it.each([
    ["c3", "c1"],
    ["p3", "c1"],
  ])("allows %s to read %s", async (from, ref) => {
    expect(
      await resolveReadableThread({
        caller: rows.find((row) => row.ref === from) as Thread,
        ref,
        threads,
      }),
    ).toMatchObject({ ok: true, target: { ref } });
  });
  it.each([
    ["c4", "thread_not_connected"],
    ["c5", "thread_not_found"],
    ["c6", "thread_not_found"],
    ["c7", "thread_not_found"],
    ["bogus", "thread_not_found"],
  ])("denies %s as %s", async (ref, code) => {
    expect(await resolveReadableThread({ caller: rows[0] as Thread, ref, threads })).toMatchObject({
      ok: false,
      error: { code },
    });
  });
});
