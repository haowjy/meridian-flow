import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createConfirmedSnapshot } from "./neon.ts";

const servers: Server[] = [];
async function fakeNeon(scenario: "success" | "failed" | "missing" | "timeout") {
  let operationReads = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && url.pathname.endsWith("/snapshot")) {
      response.end(JSON.stringify({ operations: [{ id: "op-1" }] }));
    } else if (url.pathname.endsWith("/operations/op-1")) {
      operationReads += 1;
      if (scenario === "timeout")
        response.end(JSON.stringify({ status: "running", failures_count: 0 }));
      else if (scenario === "failed")
        response.end(JSON.stringify({ status: "failed", failures_count: 1 }));
      else response.end(JSON.stringify({ status: "finished", failures_count: 0 }));
    } else if (url.pathname.endsWith("/snapshots")) {
      const names = url.searchParams;
      void names;
      response.end(
        JSON.stringify({
          snapshots:
            scenario === "missing"
              ? []
              : [
                  {
                    id: "snap-123",
                    name: "predeploy-v1.2.3-20260924T000000Z",
                    branch_id: "branch-1",
                  },
                ],
        }),
      );
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake Neon server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    get reads() {
      return operationReads;
    },
  };
}
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const fixedNow = () => new Date("2026-09-24T00:00:00.000Z");
function options(baseUrl: string) {
  return {
    apiKey: "test",
    projectId: "project-1",
    branchId: "branch-1",
    tag: "v1.2.3",
    baseUrl,
    now: fixedNow,
    pollMs: 1,
  };
}

describe("Neon snapshot seam", () => {
  it("waits for a finished operation and finds the named snapshot", async () => {
    const api = await fakeNeon("success");
    await expect(createConfirmedSnapshot(options(api.url))).resolves.toMatchObject({
      id: "snap-123",
    });
  });
  it("fails on unsuccessful operations", async () => {
    const api = await fakeNeon("failed");
    await expect(createConfirmedSnapshot(options(api.url))).rejects.toThrow(
      "non-success status 'failed'",
    );
  });
  it("fails if the completed snapshot is absent from the snapshot list", async () => {
    const api = await fakeNeon("missing");
    await expect(createConfirmedSnapshot(options(api.url))).rejects.toThrow(
      "not present in the snapshot list",
    );
  });
  it("bounds operation polling", async () => {
    const api = await fakeNeon("timeout");
    await expect(createConfirmedSnapshot({ ...options(api.url), timeoutMs: 10 })).rejects.toThrow(
      "timed out",
    );
  });
});
