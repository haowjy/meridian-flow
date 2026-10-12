// @vitest-environment jsdom
/** Brief Retry and Stop: the card first, the server's seed replaces it by id, failure lands on the card. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
const api = vi.hoisted(() => ({ retryHandoffBrief: vi.fn() }));
vi.mock("@/client/api/threads-api", () => api);
const transport = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("@/client/providers/TransportProvider", () => ({ useThreadTransport: () => transport }));
const invalidateQueries = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries }) }));
const announcements = vi.hoisted(() => ({ announce: vi.fn(), announceError: vi.fn() }));
vi.mock("@/client/stores", () => announcements);

import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type HandoffBrief, useHandoffBrief } from "./useHandoffBrief";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function seed(id: string, status: Turn["status"], position: number): Turn {
  return {
    id,
    threadId: "dest",
    position,
    prevTurnId: null,
    role: "system",
    status,
    error: status === "error" ? "This handoff brief couldn't be generated. Try again." : null,
    blocks: [],
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "source",
      sourceRef: "c1",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
    },
  } as unknown as Turn;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const failed = seed("s", "error", 1);
const reply = { ...seed("a", "complete", 2), role: "assistant", metadata: null } as Turn;

let root: Root;
let latest: HandoffBrief;
function Probe({ turns }: { turns: readonly Turn[] }) {
  latest = useHandoffBrief({ threadId: "dest", storedTurns: turns });
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe turns={[failed, reply]} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("useHandoffBrief Retry", () => {
  it("marks it failed on a lost request, and its Retry re-sends the same id", async () => {
    api.retryHandoffBrief.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => latest.retry(failed));
    const lost = latest.localSeeds[0] as Turn;
    expect(lost).toMatchObject({
      status: "error",
      error: "Couldn't start a new brief. Try again.",
    });
    expect(announcements.announceError).toHaveBeenCalledWith(
      "Couldn't start a new brief. Try again.",
    );
    const again = deferred<Turn>();
    api.retryHandoffBrief.mockReturnValueOnce(again.promise);
    await act(async () => latest.retry(lost));
    expect(api.retryHandoffBrief).toHaveBeenLastCalledWith("dest", { id: lost.id });
    expect(latest.localSeeds).toHaveLength(1);
    expect(latest.localSeeds[0]).toMatchObject({ id: lost.id, status: "pending", error: null });
  });
});

describe("useHandoffBrief Stop", () => {
  it("clears Stopping when the cancel fails, and records the failure for the card", async () => {
    transport.cancel.mockRejectedValueOnce(new Error("offline"));
    await act(async () => latest.stop("s"));
    expect(latest.stopping.has("s")).toBe(false);
    expect(latest.stopFailed.has("s")).toBe(true);
    expect(announcements.announceError).toHaveBeenCalledWith("Couldn't stop the brief. Try again.");
    transport.cancel.mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => latest.stop("s"));
    expect(latest.stopFailed.has("s")).toBe(false);
  });
});
