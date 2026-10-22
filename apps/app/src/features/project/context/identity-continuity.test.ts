/** A stored id is rewritten only while the current projection resolves it elsewhere. */
import { type ResourceRecord, reserveResourceDocument } from "@meridian/resource-replica";
import { beforeEach, expect, it, vi } from "vitest";
import { ResourceIdentityFeed } from "@/core/resources/resource-identity-feed";
import { IdentityContinuity } from "./identity-continuity";

const stored = vi.hoisted(() => ({
  recents: [] as { projectId: string; documentId: string }[],
  notify: () => {},
}));
vi.mock("@/client/recents", () => ({
  getAccountRecentsSnapshot: () => ({ items: stored.recents }),
  subscribeAccountRecents: (listener: () => void) => {
    stored.notify = listener;
    return () => undefined;
  },
  followAccountRecentIdentity: (_a: string, projectId: string, from: string, to: string) => {
    stored.recents = stored.recents.map((r) =>
      r.projectId === projectId && r.documentId === from ? { ...r, documentId: to } : r,
    );
  },
}));
vi.mock("@/client/working-set", () => ({
  followRouteIdentity: (routes: unknown[]) => routes,
  readRecentRoutes: () => [],
  replaceRecentRoutes: () => [],
  subscribeWorkingSetHydration: () => () => undefined,
}));

function record(handle: string, documentId: string, aliases: string[] = []): ResourceRecord {
  const { next } = reserveResourceDocument({
    projectId: "project",
    handle,
    documentId,
    databaseName: handle,
    schema: "document",
    intentId: `create-${handle}`,
  });
  next.resource.aliases = Object.fromEntries(
    aliases.map((alias) => [alias, { introducedAtIdentityRevision: 2 }]),
  );
  return next;
}

/** Observe each snapshot, then record an opening of A, as the writer would. */
function run(...snapshots: ResourceRecord[][]) {
  const feed = new ResourceIdentityFeed();
  const continuity = new IdentityContinuity("account", {
    onProjection: (listener) => feed.subscribeProjection(listener),
  });
  for (const records of snapshots) feed.observe(records);
  stored.recents = [{ projectId: "project", documentId: "A" }];
  stored.notify();
  continuity.dispose();
  return stored.recents[0]?.documentId;
}

beforeEach(() => {
  stored.recents = [];
});

it("moves an id only while no record holds it, in any arrival order", () => {
  const reminted = record("reminted", "B", ["A"]);
  const real = record("real", "A");
  expect(run([record("joined", "B", ["A"])])).toBe("B");
  expect(run([reminted, real])).toBe("A");
  expect(run([real, reminted])).toBe("A");
  expect(run([reminted], [reminted, real])).toBe("A");
});
