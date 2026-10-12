/** The open-imports list as the app reads it: the destination folder travels by id. */
import type { ImportSummary } from "@meridian/contracts";
import { H3 } from "nitro/h3";
import { expect, it, vi } from "vitest";
import handler from "./index.get.js";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const summary: ImportSummary = {
  importId: "33333333-3333-4333-8333-333333333333",
  state: "ready",
  destination: { folderUri: "kb://Book/", folderId: "44444444-4444-4444-8444-444444444444" },
  sort: false,
  counts: {
    total: 1,
    landed: 0,
    failed: 0,
    arriving: 1,
    deleted: 0,
    notImported: 0,
    skipped: 0,
    findings: 0,
  },
  lastActivityAt: "2026-10-12T00:00:00.000Z",
  version: "7",
  dismissedAt: null,
};

vi.mock("../../../../../lib/auth-gate.js", () => ({
  requireAppUser: async () => ({
    user: { userId },
    app: {
      projectRepo: { findById: async () => ({ id: projectId, userId }) },
      imports: () => ({ listOpen: async () => [summary] }),
    },
  }),
}));

const app = new H3().get("/api/projects/:projectId/imports", handler);

it("answers the open imports with each destination folder's id", async () => {
  const response = await app.request(`http://localhost/api/projects/${projectId}/imports?open=1`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([summary]);
});

it("refuses a list without the open filter", async () => {
  const response = await app.request(`http://localhost/api/projects/${projectId}/imports`);
  expect(response.status).toBe(400);
});
