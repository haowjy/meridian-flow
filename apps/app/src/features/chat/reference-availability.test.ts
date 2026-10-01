/** When the chat's exact-reference store asks again, and what it draws meanwhile. */

import type {
  ProjectContextIdentityLookupResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";

import { createReferenceAvailability } from "./reference-availability";

const DOC = "01900000-0000-7000-8000-000000000001";
const generation = "1" as never;
const authority = { kind: "project", projectId: "p" } as never;
const available: ProjectContextIdentityResolution = {
  kind: "available",
  documentId: DOC,
  generation,
  authority,
  entry: { uri: "manuscript://gate.md", name: "gate.md" },
} as never;
const deleted: ProjectContextIdentityResolution = {
  kind: "deleted",
  documentId: DOC,
  generation,
  lastAuthority: authority,
} as never;

const flush = async () => {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
};

function answering(world: () => ProjectContextIdentityResolution[]) {
  return vi.fn(
    async (ids: readonly string[]): Promise<ProjectContextIdentityLookupResult> => ({
      projectId: "p" as never,
      resolutionId: "r",
      resolutions: world().filter((resolution) => ids.includes(resolution.documentId)),
    }),
  );
}

describe("createReferenceAvailability", () => {
  it("asks again about a reference scrolled away during a delete, once it is shown again", async () => {
    let world = [available];
    const lookup = answering(() => world);
    const store = createReferenceAvailability(lookup);
    const stop = store.watch([DOC]);
    await flush();
    expect(store.snapshot().get(DOC)?.available).toBe(true);

    // The turn scrolls out of the virtualized transcript; then the delete.
    stop();
    world = [deleted];
    store.refresh();
    await flush();
    expect(lookup).toHaveBeenCalledTimes(1);

    store.watch([DOC]);
    // The stale answer stays drawn until the new one lands: no flash.
    expect(store.snapshot().get(DOC)?.available).toBe(true);
    await flush();

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(store.snapshot().get(DOC)).toEqual({ documentId: DOC, available: false });
  });

  it("asks again after a failed first lookup, on the next watch", async () => {
    const lookup = answering(() => [available]);
    lookup.mockRejectedValueOnce(new Error("offline"));
    const store = createReferenceAvailability(lookup);
    const stop = store.watch([DOC]);
    await flush();
    expect(store.snapshot().has(DOC)).toBe(false);

    stop();
    store.watch([DOC]);
    await flush();

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(store.snapshot().get(DOC)?.available).toBe(true);
  });

  it("re-renders nothing when a recheck finds what is already drawn", async () => {
    const store = createReferenceAvailability(answering(() => [available]));
    store.watch([DOC]);
    await flush();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.snapshot();

    store.refresh();
    await flush();

    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot()).toBe(before);
  });
});
