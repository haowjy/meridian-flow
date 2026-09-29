// @vitest-environment jsdom
/**
 * The band's notice is one element at every width, so a screen reader meets
 * its alert once and a width change can't remount it.
 */
import { describe, expect, it } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { PaneHeader } from "./PaneHeader";

describe("PaneHeader notice", () => {
  it("renders a notice once, in the band's own flow", async () => {
    await withReactRoot(
      <PaneHeader
        title={<span>Arc</span>}
        notice={<p role="alert">Work couldn’t be archived</p>}
      />,
      () => {
        const alerts = document.querySelectorAll('[role="alert"]');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]?.closest("header")).not.toBeNull();
      },
    );
  });
});
