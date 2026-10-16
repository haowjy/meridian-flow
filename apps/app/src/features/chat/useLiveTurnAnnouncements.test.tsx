// @vitest-environment jsdom
import type { Turn } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { announceError, useAnnouncement } from "@/client/stores";
import { useLiveTurnAnnouncements } from "./useLiveTurnAnnouncements";

vi.mock("./error-telemetry", () => ({ reportChatError: () => {} }));

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

const turn = (status: Turn["status"]) =>
  ({ id: "f", role: "assistant", status, error: "This response failed.", blocks: [] }) as never;
const refs = { current: null };

let alert = "";
function Probe(props: { turn: Turn | null; ended: boolean }) {
  useLiveTurnAnnouncements("t", props.turn, props.ended, refs, refs);
  alert = useAnnouncement().current.assertive;
  return null;
}

async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  const show = async (current: Turn | null, ended: boolean) => {
    await act(async () => root.render(<Probe turn={current} ended={ended} />));
    await act(async () => {});
  };
  return { show, unmount: () => act(async () => root.unmount()) };
}

describe("useLiveTurnAnnouncements failures", () => {
  it("announces a failure it watched happen, and takes the alert down once the chat moves past it", async () => {
    const view = await mount();
    await view.show(turn("streaming"), false);
    await view.show(turn("error"), false);
    expect(alert).toBe("This response failed.");
    await view.show(turn("error"), true);
    expect(alert).toBe("");
    await view.unmount();
  });

  it("does not announce a failure first seen already failed, as after a reload", async () => {
    const view = await mount();
    await view.show(null, false);
    await view.show(turn("error"), false);
    expect(alert).toBe("");
    await view.unmount();
  });

  it("leaves an unrelated alert alone when a past failure ends", async () => {
    const view = await mount();
    await view.show(turn("error"), false);
    await act(async () => announceError("Couldn't stop the reply."));
    await view.show(turn("error"), true);
    expect(alert).toBe("Couldn't stop the reply.");
    await view.unmount();
  });
});
