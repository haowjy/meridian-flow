// @vitest-environment jsdom
/** Rescued words stay copyable: a refused clipboard write says so in place, and Dismiss hides the note. */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SchemaRepairEvent } from "@/core/editor/schema-repair-witness";

const clipboard = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("./clipboard", () => ({ writeClipboardText: clipboard.write }));

import { SchemaRepairNotice } from "./SchemaRepairNotice";

const repairs: SchemaRepairEvent[] = [
  {
    phase: "open",
    detectedAt: "2026-10-12T17:00:00Z",
    deletedNodeTypes: ["callout"],
    deletedClockCount: 4,
    removedText: "The elder's gaze held no warmth.",
  },
  {
    phase: "live",
    detectedAt: "2026-10-12T17:00:01Z",
    deletedNodeTypes: ["callout"],
    deletedClockCount: 1,
  },
];

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  clipboard.write.mockReset();
});

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(() =>
    root.render(
      createElement(TooltipProvider, null, createElement(SchemaRepairNotice, { repairs })),
    ),
  );
  return host;
}

it("copies a rescued fragment, reports a refused copy in place, and dismisses", async () => {
  vi.useFakeTimers();
  const host = await mount();
  expect(host.querySelector("[data-schema-repair-removed-text]")?.textContent).toBe(
    "The elder's gaze held no warmth.",
  );
  expect(host.querySelector("[data-schema-repair-no-text]")).not.toBeNull();

  const copy = host.querySelector<HTMLButtonElement>("[data-copy-schema-repair]");
  clipboard.write.mockResolvedValueOnce({ status: "done" });
  await act(async () => copy?.click());
  expect(clipboard.write).toHaveBeenCalledWith("The elder's gaze held no warmth.");
  expect(copy?.textContent).toBe("Copied");
  expect(host.querySelector("[data-schema-repair-copy-blocked]")).toBeNull();

  clipboard.write.mockResolvedValueOnce({ status: "denied", cause: new Error("NotAllowedError") });
  await act(async () => copy?.click());
  expect(host.querySelector("[data-schema-repair-copy-blocked]")?.getAttribute("role")).toBe(
    "status",
  );
  // The earlier "Copied" reset must not erase the refusal.
  await act(async () => vi.advanceTimersByTime(2000));
  expect(host.querySelector("[data-schema-repair-copy-blocked]")).not.toBeNull();

  const dismiss = host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
  await act(async () => dismiss?.click());
  expect(host.querySelector("[data-schema-repair-notice]")).toBeNull();
});
