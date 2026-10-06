/** HTTP failure is uncertainty until the server's persisted receipt proves an outcome. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import type { NamespaceRequest } from "@meridian/resource-replica";
import { beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { createResourceNamespaceTransport } from "./resource-namespace-transport";

const api = vi.hoisted(() => ({
  deleteContextEntry: vi.fn(),
  getContextOperationReceipt: vi.fn(),
  moveContextEntry: vi.fn(),
  createUntitledContextDocument: vi.fn(),
}));
vi.mock("@/client/api/projects-api", () => api);
const request: NamespaceRequest = {
  kind: "delete",
  scheme: "scratch",
  workId: "work",
  workSlug: "alpha",
  body: {
    operationId: "operation",
    path: "note.md",
    expected: { kind: "file", documentId: "document" },
  },
};
const receipt: ContextOperationReceipt = {
  operationId: "operation",
  command: {
    kind: "delete",
    uri: "scratch://@alpha/note.md",
    expected: { kind: "file", documentId: "document" },
  },
  result: { ok: false, error: { code: "conflict", uri: "scratch://@alpha/note.md" } },
};
beforeEach(() => vi.resetAllMocks());

it("reads persisted evidence immediately after an HTTP rejection", async () => {
  api.deleteContextEntry.mockRejectedValue(new HttpResponseError("conflict", 409, null));
  api.getContextOperationReceipt.mockResolvedValue(receipt);
  const transport = createResourceNamespaceTransport("account", new AbortController().signal);
  expect(await transport.submit("project", request)).toEqual({ kind: "operation", receipt });
});

it("keeps network failure and missing evidence uncertain", async () => {
  const transport = createResourceNamespaceTransport("account", new AbortController().signal);
  const offline = new TypeError("Failed to fetch");
  api.deleteContextEntry.mockRejectedValue(offline);
  await expect(transport.submit("project", request)).rejects.toBe(offline);
  expect(api.getContextOperationReceipt).not.toHaveBeenCalled();
  const http = new HttpResponseError("unavailable", 503, null);
  api.deleteContextEntry.mockRejectedValue(http);
  api.getContextOperationReceipt.mockResolvedValue(null);
  await expect(transport.submit("project", request)).rejects.toBe(http);
});
