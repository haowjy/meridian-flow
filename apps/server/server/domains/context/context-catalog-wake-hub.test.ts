import type { CatalogWakeHint } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { createContextCatalogWakeHub } from "./context-catalog-wake-hub.js";

describe("context catalog wake hub", () => {
  it("routes truth-free hints only to authorized project/user subscriptions", () => {
    const hub = createContextCatalogWakeHub();
    const projectListener = vi.fn();
    const otherListener = vi.fn();
    hub.subscribe({ projectId: "project-1", userId: "user-1", listener: projectListener });
    hub.subscribe({ projectId: "project-2", userId: "user-2", listener: otherListener });

    hub.publish({
      type: "context-catalog-hint",
      scope: { kind: "project", projectId: "project-1" },
      headRevision: "4",
    });
    hub.publish({
      type: "context-catalog-hint",
      scope: { kind: "user", userId: "user-1" },
      headRevision: "2",
    });

    expect(projectListener).toHaveBeenCalledTimes(2);
    expect(otherListener).not.toHaveBeenCalled();
  });

  it("swallows receiver failures because durable pull owns correctness", () => {
    const hub = createContextCatalogWakeHub();
    hub.subscribe({
      projectId: "project-1",
      userId: "user-1",
      listener: () => {
        throw new Error("socket closed");
      },
    });
    const hint: CatalogWakeHint = {
      type: "context-catalog-hint",
      scope: { kind: "none", projectId: "project-1" },
      headRevision: "1",
    };
    expect(() => hub.publish(hint)).not.toThrow();
  });
});
