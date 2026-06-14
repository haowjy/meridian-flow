/**
 * Compose tests: verify the in-memory service graph exposes the same app-service
 * shape as production composition while keeping unimplemented adapters explicit.
 */
import { describe, expect, it } from "vitest";
import {
  composeAppServices,
  createInMemoryAppServices,
  createProductionAppPorts,
} from "./compose.js";

describe("composeAppServices", () => {
  it("is an identity seam for already-built production ports", () => {
    const services = createInMemoryAppServices();
    expect(createProductionAppPorts(services)).toBe(services);
    expect(composeAppServices(services)).toBe(services);
  });
});

describe("createInMemoryAppServices", () => {
  it("exposes upstream-compatible thread aliases", () => {
    const services = createInMemoryAppServices();
    expect(services.repos).toMatchObject({
      phase: (services.threadRepos as unknown as { phase: string }).phase,
    });
    expect(typeof services.hub.catchup).toBe(typeof services.threadEventHub.catchup);
    expect(typeof services.hub.appendEvent).toBe(typeof services.threadEventHub.appendEvent);
  });

  it("keeps runtime tool seams present but inert by default", async () => {
    const services = createInMemoryAppServices();

    expect(services.toolRegistry.getDefinitions()).toEqual([]);
    expect(services.toolRegistry.getRegistration("read")).toBeUndefined();
    await expect(
      services.toolExecutor.executeTool(
        { id: "call-1", name: "read", arguments: { path: "kb://notes.md" } },
        {
          signal: new AbortController().signal,
          threadId: "thread-1",
          turnId: "turn-1",
          agentSlug: null,
        },
      ),
    ).rejects.toThrow("in-memory tool executor is not implemented");
  });

  it("provides no-op debug and access seams for route tests", async () => {
    const services = createInMemoryAppServices();

    expect((services.modelRequestDebug as unknown as { list(): unknown[] }).list()).toEqual([]);
    expect(await services.documentAccess.canAccessDocument("user-1", "document-1")).toBe(true);
  });
});
