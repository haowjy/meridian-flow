// @vitest-environment jsdom

/** A refused rename's repair field opens for a fresh failure only, and never over another input. */
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useRepairOnFreshFailure } from "./use-repair-on-fresh-failure";

function Probe({ failedAt, open }: { failedAt: number | undefined; open: () => void }) {
  useRepairOnFreshFailure(failedAt, open);
  return null;
}

function FocusedInput() {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => ref.current?.focus(), []);
  return <input ref={ref} aria-label="Document name" />;
}

it("opens once for a fresh failure, not for an old one, a remount, or while another input is active", async () => {
  const now = Date.now();
  const open = vi.fn();
  await withReactRoot(<Probe failedAt={now - 60_000} open={open} />, async () => {
    expect(open).not.toHaveBeenCalled();
  });
  await withReactRoot(<Probe failedAt={now - 100} open={open} />, async () => {
    expect(open).toHaveBeenCalledOnce();
  });
  // The same failure on a remounted row (a parent collapsed and expanded) stays closed.
  await withReactRoot(<Probe failedAt={now - 100} open={open} />, async () => {
    expect(open).toHaveBeenCalledOnce();
  });
  await withReactRoot(
    <>
      <FocusedInput />
      <Probe failedAt={now - 50} open={open} />
    </>,
    async () => {
      expect(open).toHaveBeenCalledOnce();
    },
  );
});
