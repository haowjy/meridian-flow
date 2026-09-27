import type { Work } from "@meridian/contracts/works";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  createWorkWithRecovery,
  readWorkCreations,
  removeWorkCreation,
  workCreationMapForQuery,
  writeWorkCreation,
} from "./work-creation-cache";

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";
const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";
const ACCOUNT_SIGNAL = new AbortController().signal;

function work(slug: string | null): Work {
  return {
    id: WORK_ID,
    projectId: PROJECT_ID,
    createdByUserId: "user",
    name: "Fight scene",
    slug,
    isNoWork: false,
    goal: null,
    status: "active",
    archivedAt: null,
    aiWriteMode: "direct",
    entityRevision: slug ? "1" : "0",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  } as Work;
}

function record(status: "pending" | "failed" | "confirmed", slug: string | null = null) {
  return {
    workId: WORK_ID,
    projectId: PROJECT_ID,
    request: { id: WORK_ID, name: "Fight scene" },
    work: slug ? work(slug) : null,
    accountSignal: ACCOUNT_SIGNAL,
    status,
    error: status === "failed" ? "Request failed" : null,
  } as const;
}

describe("Work creation cache", () => {
  it("inserts a pending Work into the collection projection", () => {
    const client = new QueryClient();
    writeWorkCreation(client, PROJECT_ID, record("pending"));

    const creations = readWorkCreations(client, PROJECT_ID);
    expect(creations[WORK_ID]).toMatchObject({
      status: "pending",
      request: { id: WORK_ID, name: "Fight scene" },
      work: null,
    });
    expect(workCreationMapForQuery(creations)).toEqual(creations);
  });

  it("keeps failure on the same identity and retries through idempotent lookup", async () => {
    const client = new QueryClient();
    writeWorkCreation(client, PROJECT_ID, record("failed"));
    const request = readWorkCreations(client, PROJECT_ID)[WORK_ID].request;
    const submittedIds: string[] = [];
    const serverWork = work("fight-scene");

    await expect(
      createWorkWithRecovery(
        request,
        async (input) => {
          submittedIds.push(input.id ?? "");
          throw new Error("Response lost");
        },
        async () => {
          throw new Error("Lookup unavailable");
        },
      ),
    ).rejects.toThrow("Response lost");
    expect(readWorkCreations(client, PROJECT_ID)[WORK_ID].status).toBe("failed");

    const retried = await createWorkWithRecovery(
      request,
      async (input) => {
        submittedIds.push(input.id ?? "");
        return serverWork;
      },
      async () => {
        throw new Error("Not needed");
      },
    );
    writeWorkCreation(client, PROJECT_ID, { ...record("confirmed", "fight-scene"), work: retried });

    expect(submittedIds).toEqual([WORK_ID, WORK_ID]);
    expect(readWorkCreations(client, PROJECT_ID)[WORK_ID]).toMatchObject({
      status: "confirmed",
      work: serverWork,
    });
  });

  it("discards a failed entry", () => {
    const client = new QueryClient();
    writeWorkCreation(client, PROJECT_ID, record("failed"));
    removeWorkCreation(client, PROJECT_ID, WORK_ID);

    expect(readWorkCreations(client, PROJECT_ID)).toEqual({});
  });
});
