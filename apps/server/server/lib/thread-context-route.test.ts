/** Behavioral coverage for stable thread-context success identity across Work rebinds. */

import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { createInMemoryUnifiedContextPortFactory } from "../domains/context/index.js";
import { resolvedWorkAuthority } from "../domains/projects/domain/work-authority.js";
import { testWorkSlug } from "../test-support/work-slug.js";
import { readThreadContextDocument, writeThreadContextDocument } from "./thread-context-route.js";

const PROJECT_ID = "00000000-0000-4000-8000-000000000101";
const THREAD_ID = "00000000-0000-4000-8000-000000000102";
const USER_ID = "00000000-0000-4000-8000-000000000103";
const ALPHA_ID = "00000000-0000-4000-8000-000000000104";
const BETA_ID = "00000000-0000-4000-8000-000000000105";

function thread(): Thread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    workId: null,
    userId: USER_ID,
    kind: "primary",
    status: "active",
    title: "Stable context identity",
    slug: null,
    currentAgent: null,
    activeLeafTurnId: null,
    parentThreadId: null,
    rootThreadId: THREAD_ID,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    deletedAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function harness(initialPrimaryWorkId: string | null) {
  let primaryWorkId = initialPrimaryWorkId;
  const slugs = new Map([
    [ALPHA_ID, testWorkSlug("alpha")],
    [BETA_ID, testWorkSlug("beta")],
  ]);
  const byId = async (projectId: string, workId: string) => {
    const workSlug = projectId === PROJECT_ID ? slugs.get(workId) : undefined;
    return workSlug ? resolvedWorkAuthority({ kind: "work", workId, workSlug }) : null;
  };
  const deps = {
    contextPorts: createInMemoryUnifiedContextPortFactory(),
    threads: { findById: async (threadId: string) => (threadId === THREAD_ID ? thread() : null) },
    threadWorks: {
      findPrimary: async () => (primaryWorkId ? { workId: primaryWorkId } : null),
    },
    works: {
      listByProject: async () =>
        [...slugs].map(([id, slug]) => ({ id, slug })) as Awaited<
          ReturnType<import("../domains/projects/index.js").WorkRepository["listByProject"]>
        >,
    },
    workAuthorityResolver: { byId, bySlug: async () => null, lockById: byId },
  };
  return {
    deps,
    rebind(workId: string | null) {
      primaryWorkId = workId;
    },
  };
}

async function write(deps: ReturnType<typeof harness>["deps"], uri: string, markdown: string) {
  return writeThreadContextDocument(deps as never, {
    threadId: THREAD_ID as never,
    userId: USER_ID as never,
    uri,
    markdown,
  });
}

async function read(deps: ReturnType<typeof harness>["deps"], uri: string) {
  return readThreadContextDocument(deps as never, {
    threadId: THREAD_ID as never,
    userId: USER_ID as never,
    uri,
  });
}

describe("thread context success identity", () => {
  it("returns the resolved real-Work URI and keeps it exact after rebind", async () => {
    const test = harness(ALPHA_ID);
    const written = await write(test.deps, "scratch://notes.md", "alpha version");
    expect(written.uri).toBe("scratch://@alpha/notes.md");
    await expect(read(test.deps, "scratch://notes.md")).resolves.toMatchObject({
      uri: "scratch://@alpha/notes.md",
      markdown: expect.stringContaining("alpha version"),
    });

    test.rebind(BETA_ID);
    await expect(write(test.deps, "scratch://notes.md", "beta version")).resolves.toMatchObject({
      uri: "scratch://@beta/notes.md",
    });
    await expect(read(test.deps, written.uri)).resolves.toMatchObject({
      uri: "scratch://@alpha/notes.md",
      markdown: expect.stringContaining("alpha version"),
      documentId: written.documentId,
    });
  });

  it("returns explicit no-Work identity and keeps it exact after binding a Work", async () => {
    const test = harness(null);
    const written = await write(test.deps, "scratch://notes.md", "unassigned version");
    expect(written.uri).toBe("scratch://@/notes.md");
    await expect(read(test.deps, "scratch://notes.md")).resolves.toMatchObject({
      uri: "scratch://@/notes.md",
      markdown: expect.stringContaining("unassigned version"),
    });

    test.rebind(ALPHA_ID);
    await write(test.deps, "scratch://notes.md", "alpha version");
    await expect(read(test.deps, written.uri)).resolves.toMatchObject({
      uri: "scratch://@/notes.md",
      markdown: expect.stringContaining("unassigned version"),
      documentId: written.documentId,
    });
  });
});
