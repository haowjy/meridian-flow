import {
  API_THREADS_PATH,
  API_THREADS_WS_PATH,
  apiThreadCancelPath,
  apiThreadMessagePath,
} from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { isApiOwnedPath, isAppOwnedAuthPath } from "./api-route-ownership";

describe("dev/prod API route ownership map", () => {
  it("keeps API contract runtime paths routed to the API service", () => {
    expect(isApiOwnedPath(API_THREADS_PATH)).toBe(true);
    expect(isApiOwnedPath(apiThreadMessagePath("thread_123"))).toBe(true);
    expect(isApiOwnedPath(apiThreadCancelPath("thread_123", "turn_123"))).toBe(true);
    expect(isApiOwnedPath(API_THREADS_WS_PATH)).toBe(true);
  });

  it("treats /api/documents/* and /api/object-store/* as server-owned", () => {
    expect(isApiOwnedPath("/api/documents/doc_123/download")).toBe(true);
    expect(isApiOwnedPath("/api/documents")).toBe(true);
    expect(isApiOwnedPath("/api/object-store/signed-url")).toBe(true);
    expect(isApiOwnedPath("/api/object-store")).toBe(true);
  });

  it("treats /api/billing/* as server-owned", () => {
    expect(isApiOwnedPath("/api/billing")).toBe(true);
    expect(isApiOwnedPath("/api/billing/balance")).toBe(true);
    expect(isApiOwnedPath("/api/billing/checkout-sessions")).toBe(true);
  });

  it("keeps auth routes app-owned", () => {
    expect(isAppOwnedAuthPath("/api/auth/callback")).toBe(true);
    expect(isAppOwnedAuthPath("/api/auth/session")).toBe(true);
    expect(isAppOwnedAuthPath("/api/threads")).toBe(false);
  });

  it("does not treat unrelated /api paths as API runtime ownership", () => {
    expect(isApiOwnedPath("/api/auth/callback")).toBe(false);
    expect(isApiOwnedPath("/api/healthz")).toBe(false);
    expect(isApiOwnedPath("/api/threadsx")).toBe(false);
    expect(isApiOwnedPath("/api/documentsx")).toBe(false);
    expect(isApiOwnedPath("/api/ws/legacy")).toBe(false);
    expect(isApiOwnedPath("/api")).toBe(false);
  });
});
