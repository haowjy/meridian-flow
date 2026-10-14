// @vitest-environment jsdom
/**
 * A pending switch is a writer-action notice, not a compaction: no dashed rule, and
 * its words and Stop depend on whether a reply holds the chat.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings[0],
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: string }) => children,
}));

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueuedControlRows } from "./QueuedControlRows";
import type { QueuedControl } from "./thread-controls";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

async function render(controls: QueuedControl[], replyRunning: boolean) {
  const host = document.createElement("div");
  await act(async () =>
    createRoot(host).render(
      <QueuedControlRows
        controls={controls}
        replyRunning={replyRunning}
        onStop={() => undefined}
      />,
    ),
  );
  return host;
}

const draftSwitch: QueuedControl = {
  id: "s",
  control: { kind: "write_mode", mode: "draft" },
  status: "queued",
};

it("shows an idle pending switch as the applied notice with its Stop, and no rule", async () => {
  const host = await render([draftSwitch], false);
  expect(host.textContent).toContain("Switched to draft mode");
  expect(host.querySelector("[aria-label='Stop switch to draft mode']")).not.toBeNull();
  expect(host.querySelector(".border-dashed")).toBeNull();
});

it("says a switch is queued while a reply runs, and names Stop for a compaction apart", async () => {
  const host = await render(
    [draftSwitch, { id: "c", control: { kind: "compact" }, status: "queued" }],
    true,
  );
  expect(host.textContent).toContain("Switch to draft mode queued");
  expect(host.querySelector("[aria-label='Stop compaction']")).not.toBeNull();
  expect(host.querySelectorAll(".border-dashed")).toHaveLength(1);
});

it("shows an applied switch awaiting its turn with no Stop", async () => {
  const host = await render([{ ...draftSwitch, status: "applied" }], true);
  expect(host.textContent).toContain("Switched to draft mode");
  expect(host.querySelector("button")).toBeNull();
});
