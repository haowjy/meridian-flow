/** Every door owns the navigation: the last one clicked is the one that speaks. */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dismissPassageNotice,
  reportPassageChanged,
  usePassageNotice,
} from "@/core/editor/passage-notice-store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type PassageDoorOpened, usePassageDoors } from "./usePassageDoors";

const tree = {
  kind: "dir" as const,
  name: "",
  path: "/",
  children: [
    {
      kind: "file" as const,
      name: "chapter-2.md",
      path: "/chapter-2.md",
      documentId: "doc-2",
      editable: true,
    },
  ],
};

const getProjectContextTree = vi.fn(async () => ({ tree }) as never);
const navigateToPassage = vi.fn();

vi.mock("@/client/api/projects-api", () => ({
  getProjectContextTree: (...args: unknown[]) => getProjectContextTree(...(args as [])),
}));
vi.mock("@/core/editor/passage-navigation", () => ({
  navigateToPassage: (...args: unknown[]) => navigateToPassage(...(args as [])),
}));

const CHAPTER_2 = { scheme: "manuscript" as const, path: "/chapter-2.md", workId: null };
const CHAPTER_3 = { scheme: "manuscript" as const, path: "/chapter-3.md", workId: null };
const ANCHOR = { blockHash: "79b9", term: "elara" };

/** Mounts the hook and hands its callback plus a live read of the notice. */
async function withDoors(
  run: (open: PassageDoorOpened, noticeFor: () => boolean) => Promise<void>,
): Promise<void> {
  let open: PassageDoorOpened | null = null;
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
  getProjectContextTree.mockClear();
  navigateToPassage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("passage doors", () => {
  it("lets an ordinary door retire a passage still resolving", async () => {
    let finish: (value: { kind: string }) => void = () => {};
    navigateToPassage.mockImplementation(
      () => new Promise((resolve) => (finish = resolve as typeof finish)),
    );

    await withDoors(async (open, noticeFor) => {
      open(CHAPTER_2, ANCHOR);
      // Let the tree lookup settle so the resolution is genuinely in flight.
      await act(async () => {});
      expect(navigateToPassage).toHaveBeenCalledTimes(1);

      // The writer changes their mind and opens a plain document door.
      open(CHAPTER_3);
      await act(async () => {
        finish({ kind: "stale" });
      });

      // The verdict belongs to a door the writer already left.
      expect(noticeFor()).toBe(false);
    });
  });

  it("clears a standing notice when any door is opened", async () => {
    await withDoors(async (open, noticeFor) => {
      await act(async () => reportPassageChanged("doc-2"));
      expect(noticeFor()).toBe(true);

      await act(async () => open(CHAPTER_3));

      expect(noticeFor()).toBe(false);
    });
  });

  it("does not look a plain door up in the tree", async () => {
    await withDoors(async (open) => {
      await act(async () => open(CHAPTER_3));

      expect(getProjectContextTree).not.toHaveBeenCalled();
      expect(navigateToPassage).not.toHaveBeenCalled();
    });
  });

  it("raises the notice when the latest door's passage is gone", async () => {
    navigateToPassage.mockResolvedValue({ kind: "stale" });

    await withDoors(async (open, noticeFor) => {
      await act(async () => open(CHAPTER_2, ANCHOR));
      await act(async () => {});

      expect(noticeFor()).toBe(true);
    });
  });
});
