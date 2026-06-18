/**
 * document-session-registry tests — retention lifecycle and R14 soft-cap guard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/transport/hocuspocus-document-transport", () => ({
  createHocuspocusDocumentTransport: () => ({
    whenSynced: Promise.resolve(),
    synced: true,
    subscribeStatus: (listener: (state: { kind: "connected" }) => void) => {
      listener({ kind: "connected" });
      return () => {};
    },
    destroy: () => {},
  }),
}));

import { getDocumentSessionRegistry } from "./document-session-registry";

describe("DocumentSessionRegistry", () => {
  afterEach(() => {
    getDocumentSessionRegistry().destroyAll();
    vi.restoreAllMocks();
  });

  it("warns once when live session count exceeds the soft cap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = getDocumentSessionRegistry();
    const ids = Array.from({ length: 51 }, (_, index) => `doc-${index}`);

    registry.retain("test-owner", ids);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("exceeds soft cap");
    expect(warn.mock.calls[0]?.[0]).toContain("51");

    registry.retain("test-owner", [...ids, "doc-extra"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
