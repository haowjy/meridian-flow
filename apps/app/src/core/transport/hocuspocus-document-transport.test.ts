/**
 * hocuspocus-document-transport tests — terminal denial classification at the
 * transport seam (R9). Per-doc denial surfaces via onAuthenticationFailed;
 * session-level auth closes use explicit 4401/4403 codes only.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { ConnectionState } from "./ThreadTransport";

type ProviderHandlers = {
  onStatus?: (params: { status: string }) => void;
  onSynced?: (params: unknown) => void;
  onAuthenticationFailed?: (params: { reason: string }) => void;
  onClose?: (params: { event: { code: number; reason: string } }) => void;
};

const { mockProviderInstances, MockProvider } = vi.hoisted(() => {
  const mockProviderInstances: Array<{
    synced: boolean;
    handlers: ProviderHandlers;
    destroyed: boolean;
    attach: () => void;
    destroy: () => void;
  }> = [];

  class MockProvider {
    synced = false;
    readonly handlers: ProviderHandlers;
    destroyed = false;

    constructor(_opts: Record<string, unknown>) {
      this.handlers = {
        onStatus: _opts.onStatus as ProviderHandlers["onStatus"],
        onSynced: _opts.onSynced as ProviderHandlers["onSynced"],
        onAuthenticationFailed:
          _opts.onAuthenticationFailed as ProviderHandlers["onAuthenticationFailed"],
        onClose: _opts.onClose as ProviderHandlers["onClose"],
      };
      mockProviderInstances.push(this);
    }

    attach(): void {}
    destroy(): void {
      this.destroyed = true;
    }
  }

  return { mockProviderInstances, MockProvider };
});

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: MockProvider,
  HocuspocusProviderWebsocket: class {
    status = "connecting";
  },
  WebSocketStatus: {
    Connected: "connected",
    Connecting: "connecting",
    Disconnected: "disconnected",
  },
}));

import { createHocuspocusDocumentTransport } from "./hocuspocus-document-transport";

function makeTransport(documentId = "doc-test") {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const states: ConnectionState[] = [];
  const transport = createHocuspocusDocumentTransport({ documentId, document, awareness });
  transport.subscribeStatus?.((state) => states.push(state));
  return {
    transport,
    states,
    provider: () => {
      const instance = mockProviderInstances.at(-1);
      if (!instance) throw new Error("mock provider not created");
      return instance;
    },
  };
}

describe("createHocuspocusDocumentTransport terminal denial", () => {
  beforeEach(() => {
    mockProviderInstances.length = 0;
  });

  it.each([
    4401, 4403,
  ] as const)("classifies close code %i as unauthorized and destroys the provider", (code) => {
    const { transport, states, provider } = makeTransport();
    provider().handlers.onClose?.({ event: { code, reason: "auth_failed" } });

    expect(states.at(-1)).toEqual({ kind: "unauthorized", reason: "auth_failed", code });
    expect(provider().destroyed).toBe(true);

    transport.destroy();
  });

  it("classifies onAuthenticationFailed as unauthorized and destroys the provider", () => {
    const { transport, states, provider } = makeTransport();
    provider().handlers.onAuthenticationFailed?.({ reason: "permission-denied" });

    expect(states.at(-1)).toEqual({ kind: "unauthorized", reason: "permission-denied" });
    expect(provider().destroyed).toBe(true);

    transport.destroy();
  });

  it.each([1000, 1006] as const)("does not treat normal close code %i as terminal", (code) => {
    const { transport, states, provider } = makeTransport();
    provider().handlers.onClose?.({ event: { code, reason: "connection lost" } });

    expect(states.at(-1)?.kind).not.toBe("unauthorized");
    expect(provider().destroyed).toBe(false);

    transport.destroy();
  });
});
