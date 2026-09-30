// @vitest-environment jsdom
/** Control turns speak their state changes: history at mount is silent, changes are heard. */
import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
const announcer = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("@/client/stores", () => announcer);

import { useControlTurnAnnouncements } from "./useControlTurnAnnouncements";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let root: Root;
beforeEach(() => {
  announcer.announce.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
});

const seed = (id: string, status: string, position: number, error: string | null = null) =>
  ({
    id,
    role: "system",
    status,
    position,
    error,
    blocks: [],
    metadata: { kind: "derivation_seed", derivation: "handoff", sourceThreadId: "source" },
  }) as unknown as Turn;

function Probe({ turns }: { turns: Turn[] }) {
  useControlTurnAnnouncements(turns);
  return null;
}

describe("useControlTurnAnnouncements for handoff briefs", () => {
  it("is silent about history, then speaks each brief state the writer witnesses", async () => {
    await act(async () => root.render(<Probe turns={[seed("s", "pending", 1)]} />));
    expect(announcer.announce).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe turns={[seed("s", "complete", 1)]} />));
    expect(announcer.announce).toHaveBeenLastCalledWith("Handoff brief ready");
    await act(async () => root.render(<Probe turns={[seed("s", "cancelled", 1)]} />));
    expect(announcer.announce).toHaveBeenLastCalledWith("Handoff brief stopped");
  });

  it("speaks a failed brief's writer copy, and a Retry's new seed as it starts", async () => {
    await act(async () => root.render(<Probe turns={[seed("s", "pending", 1)]} />));
    await act(async () =>
      root.render(
        <Probe turns={[seed("s", "error", 1, "This handoff brief couldn't be generated.")]} />,
      ),
    );
    expect(announcer.announce).toHaveBeenLastCalledWith(
      "This handoff brief couldn't be generated.",
    );
    await act(async () =>
      root.render(<Probe turns={[seed("s", "error", 1, "x"), seed("s2", "pending", 2)]} />),
    );
    expect(announcer.announce).toHaveBeenLastCalledWith("Writing the handoff brief");
  });
});
