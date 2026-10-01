// @vitest-environment jsdom
import { act, type RefObject } from "react";
import { expect, it, vi } from "vitest";

import type { ComposerHandle } from "@/components/app/composer";
import { withReactRoot } from "@/test-support/react-dom-harness";

import { useThreadNavigationAnnounce } from "./useThreadNavigationAnnounce";

const announce = vi.hoisted(() => vi.fn());
vi.mock("@/client/stores", () => ({ announce }));

it("focuses the composer on navigation, not when the open chat is renamed", async () => {
  const focus = vi.fn();
  const composerRef = { current: { focus } } as unknown as RefObject<ComposerHandle | null>;
  let setView: (view: { threadId: string; title: string }) => void = () => {};
  function Probe() {
    const [view, update] = useStateLike({ threadId: "a", title: "First" });
    setView = update;
    useThreadNavigationAnnounce(view.threadId, view.title, composerRef);
    return null;
  }
  await withReactRoot(<Probe />, async () => {
    expect(focus).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("First");
    await act(async () => setView({ threadId: "a", title: "Renamed" }));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
    await act(async () => setView({ threadId: "b", title: "Second" }));
    expect(focus).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith("Second");
  });
});

import { useState as useStateLike } from "react";
