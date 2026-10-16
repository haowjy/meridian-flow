/** Every door owns the navigation: the last one clicked is the one that speaks. */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dismissPassageNotice, usePassageNotice } from "@/core/editor/passage-notice-store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type PassageDoors, usePassageDoors } from "./usePassageDoors";

const navigateToPassage = vi.fn();

vi.mock("@/core/editor/passage-navigation", () => ({
  navigateToPassage: (...args: unknown[]) => navigateToPassage(...(args as [])),
}));

const RESOLVED = { documentId: "doc-2" };
const ANCHOR = { blockHash: "79b9", term: "elara" };

/** Mounts the hook and hands its callback plus a live read of the notice. */
async function withDoors(
  run: (open: PassageDoors, noticeFor: () => boolean) => Promise<void>,
): Promise<void> {
  let open: PassageDoors | null = null;
  let showing = false;
  function Doors() {
    open = usePassageDoors("project-1", null);
    showing = usePassageNotice("doc-2");
    return null;
  }
  await withReactRoot(<Doors />, async () => {
    if (!open) throw new Error("hook never mounted");
    await run(open, () => showing);
  });
}

beforeEach(() => {
  dismissPassageNotice();
  navigateToPassage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("passage doors", () => {
  it("lets a newer intent retire a passage still resolving", async () => {
    let finish: (value: { kind: string }) => void = () => {};
    navigateToPassage.mockImplementation(
      () => new Promise((resolve) => (finish = resolve as typeof finish)),
    );

    await withDoors(async (open, noticeFor) => {
      open.land(null, ANCHOR, RESOLVED);
      expect(navigateToPassage).toHaveBeenCalledTimes(1);

      // The writer changes their mind and follows another link.
      open.retire();
      await act(async () => {
        finish({ kind: "stale" });
      });

      // The verdict belongs to a door the writer already left.
      expect(noticeFor()).toBe(false);
    });
  });

  it("raises the notice when the latest door's passage is gone", async () => {
    navigateToPassage.mockResolvedValue({ kind: "stale" });

    await withDoors(async (open, noticeFor) => {
      await act(async () => open.land(null, ANCHOR, RESOLVED));

      expect(noticeFor()).toBe(true);
    });
  });
});
